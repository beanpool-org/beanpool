/**
 * Keyholder fragment routes — the HTTP surface for the split (ONBOARDING Part 5).
 *
 * Everything the keeper system needs to be *reachable*: deposit a generation, read a member's
 * keeper types, and drop the lot. Collection and release (D6/D7) are deliberately not here — the
 * release rules need state this PR does not add, and half a release path is worse than none.
 *
 * ## The one rule this file exists to enforce
 *
 * `POST /api/recovery/shares` REFUSES any `sso` fragment.
 *
 * `putShareGeneration` will happily store an sso fragment with whatever `ssoLookupHash` the caller
 * supplies. That is correct for a storage primitive and catastrophic as an HTTP endpoint: the
 * lookup hash is what a restore searches on, so a client-supplied one indexes a fragment under
 * somebody else's Google account, and #220 exists precisely to make the node derive it from a
 * token it verified. Exposing the primitive raw would route around that in one line of client
 * code — the guard would still be there, in a function nobody had to call.
 *
 * So the sign-in path is a separate endpoint that cannot be reached without a verified token, and
 * the general one refuses the fragment type outright rather than silently dropping the field. A
 * client sending it has misunderstood something, and a 400 says so while a silent strip does not.
 *
 * ## Why the owner is never a body field
 *
 * `ownerPubkey` is always `ctx.state.actor` — the key that signed the request. The signature
 * middleware's spoof guard only inspects TOP-LEVEL body fields, and every fragment here is nested
 * inside `shares[]`, so a body-supplied owner would sail past it. Taking it from the actor means
 * the question never arises.
 *
 * ## What the public read gives away
 *
 * `GET /api/recovery/keepers/:callsign` is a membership oracle: it answers, to anyone, whether a
 * callsign exists on this node and roughly how it is protected. ONBOARDING accepts this — a
 * frightened user on a new phone has no identity to sign with, and the restore screen cannot be
 * drawn without it — and it is rate-limited and returns types and counts only, never identities.
 * Answering with keeper pubkeys would turn a callsign into a map of who trusts whom.
 */

import Router from '@koa/router';
import { RECOVERY_THRESHOLD } from '@beanpool/core';
import { db } from '../db/db.js';
import { getMember } from '../state-engine.js';
import {
    putShareGeneration,
    listKeeperTypes,
    countCurrentShares,
    getCurrentGeneration,
    canRemoveKeeper,
    deleteAllShares,
    RecoveryShareError,
    type KeeperShareInput,
    type KeeperType,
} from '../engine/recovery-shares.js';
import { depositSsoKeeperGeneration, KeeperDepositError } from '../engine/keeper-deposit.js';
import { issueNonce, SsoVerificationError, SSO_PROVIDERS } from '../sso.js';
import type { RouteDeps } from './types.js';

/** Mirrors the CHECK constraint on `recovery_shares.holder_type`. */
const KEEPER_TYPES: readonly KeeperType[] = ['device', 'hub', 'member', 'sso'];

/**
 * Upper bound on fragments in one generation.
 *
 * The Shamir x-coordinate is a byte, so 255 is the mathematical ceiling and the engine already
 * enforces it. 32 is the useful ceiling: a member with 32 keepers has a social graph problem, not
 * a recovery one, and every fragment past the threshold is another row inserted inside a single
 * transaction on a 1-CPU VM. The 2 MB body cap bounds the total bytes either way — this bounds
 * the row count, which is the part the body cap does not.
 */
const MAX_KEEPERS = 32;

/**
 * Ceiling on each base64 field.
 *
 * A fragment of a 12-word phrase is ~50-100 bytes, so ~150 base64 characters. 4096 is far past any
 * legitimate value and still small enough that 32 of them cannot be used to park megabytes in a
 * table nothing prunes.
 */
const MAX_FIELD_CHARS = 4096;

/** holder_ref is a member pubkey (64 hex), a provider name, or 'self'. */
const MAX_HOLDER_REF_CHARS = 128;

class BadRequest extends Error {}

function requireString(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string' || !value.length) {
        throw new BadRequest(`'${field}' is required.`);
    }
    if (value.length > max) {
        throw new BadRequest(`'${field}' is longer than ${max} characters.`);
    }
    return value;
}

function optionalString(value: unknown, field: string, max: number): string | null {
    if (value === undefined || value === null || value === '') return null;
    return requireString(value, field, max);
}

/**
 * Validate the wire shape of one generation.
 *
 * Deliberately strict about the fragment *envelope* and silent about its contents: the node cannot
 * decrypt any of this and must not pretend to. What it can check is that the set is structurally
 * capable of being recombined later, which is what the engine's own checks then finish.
 */
function parseShares(raw: unknown): KeeperShareInput[] {
    if (!Array.isArray(raw)) throw new BadRequest("'shares' must be an array of fragments.");
    if (raw.length === 0) throw new BadRequest('No recovery fragments were supplied.');
    if (raw.length > MAX_KEEPERS) {
        throw new BadRequest(`A split may have at most ${MAX_KEEPERS} keepers, got ${raw.length}.`);
    }

    return raw.map((entry, i) => {
        if (!entry || typeof entry !== 'object') {
            throw new BadRequest(`Fragment ${i} is not an object.`);
        }
        const s = entry as Record<string, unknown>;

        const holderType = s.holderType;
        if (typeof holderType !== 'string' || !KEEPER_TYPES.includes(holderType as KeeperType)) {
            throw new BadRequest(
                `Fragment ${i} has an unknown keeper type. Expected one of: ${KEEPER_TYPES.join(', ')}.`,
            );
        }

        const shareIndex = s.shareIndex;
        if (!Number.isInteger(shareIndex)) {
            throw new BadRequest(`Fragment ${i} has a non-integer share index.`);
        }

        // A device keeper is RECORDED, not uploaded: K1's bytes live in the phone's own backup and
        // nowhere else. Demanding ciphertext here was what let the node become a second holder of
        // it. Refused rather than silently dropped, for the same reason a client-supplied lookup
        // hash is refused — a client sending it has misunderstood where that piece lives, and
        // quietly discarding the field would leave it believing the node kept a copy.
        const isDevice = holderType === 'device';
        if (isDevice && (s.encryptedShare || s.shareIv || s.shareTag)) {
            throw new BadRequest(
                `Fragment ${i} is a device keeper, so its bytes stay on the phone. Send it with `
                + 'empty ciphertext fields — the node records that the keeper exists, nothing more.',
            );
        }

        return {
            holderType: holderType as KeeperType,
            holderRef: requireString(s.holderRef, `shares[${i}].holderRef`, MAX_HOLDER_REF_CHARS),
            // Range (1-255) and uniqueness are the engine's to enforce — it is the layer that knows
            // why, and duplicating the rule here would let the two drift.
            shareIndex: shareIndex as number,
            encryptedShare: isDevice ? '' : requireString(s.encryptedShare, `shares[${i}].encryptedShare`, MAX_FIELD_CHARS),
            shareIv: isDevice ? '' : requireString(s.shareIv, `shares[${i}].shareIv`, MAX_FIELD_CHARS),
            shareTag: isDevice ? '' : requireString(s.shareTag, `shares[${i}].shareTag`, MAX_FIELD_CHARS),
            ephemeralPubkey: optionalString(s.ephemeralPubkey, `shares[${i}].ephemeralPubkey`, MAX_FIELD_CHARS),
            ssoLookupHash: optionalString(s.ssoLookupHash, `shares[${i}].ssoLookupHash`, MAX_FIELD_CHARS),
            ssoLookupSalt: optionalString(s.ssoLookupSalt, `shares[${i}].ssoLookupSalt`, MAX_FIELD_CHARS),
            kdfParams: optionalString(s.kdfParams, `shares[${i}].kdfParams`, MAX_FIELD_CHARS),
        };
    });
}

/**
 * Statuses that cannot hold recovery fragments.
 *
 * DELIBERATELY NARROWER than `assertMemberActive`, which also blocks 'disabled' and 'suspended'
 * (CR asked whether the divergence was intentional — it is, and here is the reason it was not
 * written down before).
 *
 * Every other write path in this codebase moves value or reaches other members, so a sanctioned
 * account is stopped. Nothing here does either: each endpoint touches only the caller's OWN
 * fragments, and the fragments are opaque to the node. A suspended member re-splitting their
 * keepers harms nobody.
 *
 * What blocking them WOULD do is make a temporary sanction permanent by accident. A suspended
 * member who cannot add a keeper, and then loses their phone, has lost the account outright —
 * moderation turning into confiscation, which Principle 8 exists to prevent ("loss degrades the
 * system; it does not cost anyone an account"). Recovery is the last thing that should switch off
 * when someone is in trouble.
 *
 * 'migrated' and 'pruned' are different in kind: both are tombstones, not sanctions. The account
 * is gone, and a pruned member's callsign is explicitly reusable — `idx_members_callsign_unique`
 * excludes those rows — so fragments filed against one would sit under a name that now belongs to
 * somebody else.
 */
const CANNOT_HOLD_FRAGMENTS = new Set(['migrated', 'pruned']);

/**
 * The signer, if they are a member of this node whose account still exists.
 *
 * A valid signature only proves possession of *some* keypair (SRV-2/SRV-4). `owner_pubkey` is a
 * foreign key into `members`, so an anonymous key would fail at the database with a constraint
 * error rather than a sentence.
 */
function activeSigner(ctx: any): string | null {
    const actor = ctx.state?.actor as string | undefined;
    if (!actor) return null;
    const member = getMember(actor);
    if (!member || CANNOT_HOLD_FRAGMENTS.has(String(member.status))) return null;
    return actor;
}

function unauthenticated(ctx: any): void {
    ctx.status = 401;
    ctx.body = { error: 'This request must be signed by an active member of this node.' };
}

export function createKeeperRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { rateLimit } = deps;

    /**
     * A sign-in nonce, bound to the caller.
     *
     * Node-issued rather than client-chosen, because a nonce the client picks is a nonce an
     * attacker picks: the whole anti-replay property is that this node knows it minted the value
     * for this member and has not seen it come back yet. Every node in the federation accepts the
     * same provider audiences, so without it a token obtained at one node is replayable at every
     * other one.
     */
    router.post('/api/recovery/sso-nonce', async (ctx) => {
        const owner = activeSigner(ctx);
        if (!owner) return unauthenticated(ctx);
        // Rate-limited even though it is signed: issuing is cheap but unbounded issuing grows the
        // in-memory nonce map, and the sweep that bounds it is throttled to once a minute.
        if (!rateLimit(ctx)) return;

        ctx.status = 200;
        ctx.body = {
            nonce: issueNonce(owner),
            // The client needs this to know when to stop waiting on a sign-in sheet, not to
            // enforce anything — expiry is checked here.
            expiresInSeconds: 600,
            providers: SSO_PROVIDERS,
        };
    });

    /**
     * Upload a whole generation — the initial split, adding a keeper, removing one, or rotating
     * after a keeper's key changed. All four are the same operation, which is what keeps "how many
     * fragments does this member have" answerable at every instant.
     *
     * Refuses sso fragments. See the file header — this is the point of the file.
     */
    router.post('/api/recovery/shares', async (ctx) => {
        const owner = activeSigner(ctx);
        if (!owner) return unauthenticated(ctx);

        const body = (ctx as any).requestBody || {};
        let shares: KeeperShareInput[];
        try {
            shares = parseShares(body.shares);
        } catch (e) {
            if (e instanceof BadRequest) { ctx.status = 400; ctx.body = { error: e.message }; return; }
            throw e;
        }

        // Refused, not stripped. A client sending one believes it decides which provider account a
        // fragment belongs to; quietly removing the field would leave that belief intact until it
        // mattered, and the next thing it would try is a hash pointing at somebody else.
        if (shares.some(s => s.holderType === 'sso')) {
            ctx.status = 400;
            ctx.body = {
                error: 'A sign-in fragment cannot be deposited here. Use POST /api/recovery/shares/sso, '
                    + 'which verifies the provider token and derives the lookup hash on this node.',
            };
            return;
        }
        // Same reasoning one level down: a lookup hash on a device or hub fragment is still a
        // lookup hash, and findShareBySsoLookup matches on the column with no keeper-type filter.
        if (shares.some(s => s.ssoLookupHash || s.ssoLookupSalt)) {
            ctx.status = 400;
            ctx.body = { error: 'A lookup hash is derived by this node, not supplied by the client.' };
            return;
        }

        try {
            const generation = putShareGeneration(owner, shares);
            ctx.status = 200;
            ctx.body = {
                generation,
                shareCount: shares.length,
                threshold: RECOVERY_THRESHOLD,
                keepers: listKeeperTypes(owner),
            };
        } catch (e) {
            if (e instanceof RecoveryShareError) { ctx.status = 400; ctx.body = { error: e.message }; return; }
            throw e;
        }
    });

    /**
     * Upload a generation that includes exactly one sign-in fragment.
     *
     * Separate from the route above because the fragment cannot be stored until a provider token
     * has been verified, and the lookup hash is derived from the `sub` inside it. The client sends
     * the whole new generation, not just the sign-in piece: fragments from two different splits
     * cannot be recombined, so "add Google as a keeper" is really "re-split and store the new set".
     */
    router.post('/api/recovery/shares/sso', async (ctx) => {
        const owner = activeSigner(ctx);
        if (!owner) return unauthenticated(ctx);
        // Rate-limited because this reaches the provider's JWKS and runs an scrypt on success.
        if (!rateLimit(ctx)) return;

        const body = (ctx as any).requestBody || {};
        let shares: KeeperShareInput[];
        try {
            shares = parseShares(body.shares);
        } catch (e) {
            if (e instanceof BadRequest) { ctx.status = 400; ctx.body = { error: e.message }; return; }
            throw e;
        }

        try {
            const result = await depositSsoKeeperGeneration({
                // Passed through unvalidated on purpose: depositSsoKeeperGeneration checks it
                // against the provider table before it can become a stored holder_ref, and one
                // gate is easier to keep correct than two that must agree.
                provider: body.provider,
                ownerPubkey: owner,
                shares,
                idToken: typeof body.idToken === 'string' ? body.idToken : '',
                nonce: typeof body.nonce === 'string' ? body.nonce : '',
            });
            ctx.status = 200;
            ctx.body = {
                generation: result.generation,
                provider: result.provider,
                // Undefined for Apple after the first authorization, which is normal — the keeper
                // list renders the provider name alone rather than treating it as a failure.
                email: result.email,
                shareCount: result.shareCount,
                threshold: RECOVERY_THRESHOLD,
                keepers: listKeeperTypes(owner),
            };
        } catch (e) {
            // 400 rather than 401/403 throughout: none of these mean "you are not signed in" — the
            // caller is a verified member — they mean the sign-in they attached did not check out.
            if (e instanceof SsoVerificationError || e instanceof KeeperDepositError
                || e instanceof RecoveryShareError) {
                ctx.status = 400;
                ctx.body = { error: e.message };
                return;
            }
            throw e;
        }
    });

    /**
     * How a member is protected, for the restore screen. Public and rate-limited (D8: recovery
     * starts at the hub, and the recovering device has no identity yet).
     *
     * Types and counts only. See the file header for what this deliberately does not answer.
     */
    router.get('/api/recovery/keepers/:callsign', async (ctx) => {
        if (!rateLimit(ctx)) return;

        const callsign = (ctx.params.callsign || '').trim().toLowerCase();
        if (!callsign) { ctx.status = 400; ctx.body = { error: 'Missing callsign' }; return; }

        // The predicate MUST match idx_members_callsign_unique's exactly — it is
        // `WHERE status NOT IN ('migrated', 'pruned')` (db.ts). Two things go wrong otherwise, and
        // this route had both (CR):
        //
        //   1. A FALSE 409 blocking a real recovery. Pruning never clears the callsign and the
        //      index excludes pruned rows on purpose, so a callsign IS reusable once its owner is
        //      pruned. `status != 'migrated'` matches the tombstone as well as the live member,
        //      sees two rows, and calls an unambiguous member ambiguous — on the one screen that
        //      exists for somebody who has just lost their phone.
        //   2. A full table SCAN on a public, unauthenticated endpoint. A predicate that does not
        //      match the partial index cannot use it; matching it turns the plan into
        //      SEARCH members USING INDEX idx_members_callsign_unique.
        //
        // Verified both with EXPLAIN QUERY PLAN against the real index DDL.
        const matches = db.prepare(`
            SELECT public_key FROM members
            WHERE LOWER(callsign) = ? AND status NOT IN ('migrated', 'pruned')
        `).all(callsign) as { public_key: string }[];

        // Callsigns are unique per node (#83), so this is one row or none. Refusing rather than
        // picking on the ambiguous case matters on nodes that predate the unique index: choosing
        // arbitrarily would show one stranger's keeper layout under another's name.
        if (matches.length > 1) {
            ctx.status = 409;
            ctx.body = { error: 'That callsign is ambiguous on this node.' };
            return;
        }
        // Same 200 shape for "no such callsign" and "member with no split", deliberately. The
        // endpoint is already a membership oracle by necessity; it does not need to be a crisper
        // one, and the restore screen's next step is identical either way — fall back to the 12
        // words. See R-oracle in ONBOARDING Part 9.
        const owner = matches[0]?.public_key;
        const keepers = owner ? listKeeperTypes(owner) : [];
        const total = keepers.reduce((n, k) => n + k.count, 0);

        ctx.status = 200;
        ctx.body = {
            callsign,
            keepers,
            total,
            threshold: RECOVERY_THRESHOLD,
            // "4 of 3 — you can afford to lose 1" is the number users actually act on (Part 2),
            // so it is computed here rather than left to each client to get right.
            canAffordToLose: Math.max(0, total - RECOVERY_THRESHOLD),
            recoverable: total >= RECOVERY_THRESHOLD,
        };
    });

    /**
     * Drop every fragment — "stop protecting my account this way".
     *
     * NOT how a single keeper is removed. Removing one keeper is a re-split uploaded through
     * `POST /api/recovery/shares` without them, because deleting a row revokes nothing: the
     * departing keeper still physically holds their bytes, and a bare delete would take a member
     * from "protected by 4" to "protected by 3, one of whom is someone they just removed". The
     * `canRemoveKeeper` flag below is what lets a client refuse the request before the user
     * believes it worked.
     *
     * Requires an explicit confirmation string because it is irreversible from the server's side
     * and leaves the member on the 12 words alone.
     */
    router.delete('/api/recovery/shares', async (ctx) => {
        const owner = activeSigner(ctx);
        if (!owner) return unauthenticated(ctx);

        const body = (ctx as any).requestBody || {};
        if (body.confirm !== 'delete-my-recovery-keepers') {
            ctx.status = 400;
            ctx.body = {
                error: 'Deleting every recovery fragment needs an explicit confirmation.',
                expected: { confirm: 'delete-my-recovery-keepers' },
                currentShareCount: countCurrentShares(owner),
            };
            return;
        }

        const removed = deleteAllShares(owner);
        ctx.status = 200;
        ctx.body = { removed, generation: getCurrentGeneration(owner), keepers: [] };
    });

    /**
     * Whether the caller could drop one keeper and still be recoverable.
     *
     * Signed POST rather than a GET because `ctx.state.actor` is only populated for GETs when
     * ENFORCE_READ_AUTH is on, and that is off by default — a GET here would silently have no
     * caller to answer about on most nodes, which is the kind of auth hole that reads as working.
     * The owner's full keeper list needs a signed read that does not depend on that flag, and is
     * deferred with the rest of the keeper status UI rather than half-built here.
     */
    router.post('/api/recovery/shares/status', async (ctx) => {
        const owner = activeSigner(ctx);
        if (!owner) return unauthenticated(ctx);

        const keepers = listKeeperTypes(owner);
        const total = countCurrentShares(owner);
        ctx.status = 200;
        ctx.body = {
            generation: getCurrentGeneration(owner),
            keepers,
            total,
            threshold: RECOVERY_THRESHOLD,
            canAffordToLose: Math.max(0, total - RECOVERY_THRESHOLD),
            canRemoveKeeper: canRemoveKeeper(owner),
            recoverable: total >= RECOVERY_THRESHOLD,
        };
    });

    return router;
}
