/**
 * Recovery collection — the routes a device uses to gather enough fragments to get back in.
 *
 * The other half of the keeper system. `keepers.ts` is how a member DEPOSITS a split; this is how
 * somebody who has lost their phone collects one back, under the release rules in
 * engine/recovery-release.ts (D6, D7, and K1 which the node never serves).
 *
 * ## The session is owned by a key, not by a secret
 *
 * A recovering device has no identity — the owner's key is exactly what it is rebuilding — so
 * nothing here can be authorised the way the rest of the API is. The engine was drafted around a
 * bearer session id for that reason.
 *
 * It does not need one. The device already generates an ephemeral keypair for keepers to wrap
 * fragments to, and `requireSignature` requires membership only for gated READS — a write needs a
 * valid signature and nothing more. So the device SIGNS with that ephemeral key, the collection
 * records its public half, and every later request is checked against it.
 *
 * That is strictly better than a bearer token: the session id is an identifier rather than a
 * credential, so it can appear in a log, a support ticket or a screenshot without being a way in.
 * Stealing it gets you nothing without the private key, which never leaves the recovering device.
 *
 * ## Why the owner is notified the moment one opens
 *
 * D7 says the hub's delay comes "with notification", and the notification is the part that
 * actually defends anything — the delay alone just makes a takeover slower. R1 accepts that three
 * colluding keepers can rebuild an account; what makes that survivable is the owner finding out
 * while it is happening, because cancelling and re-splitting are both one tap.
 *
 * So the alert fires when the collection OPENS, not when the hub is asked for. That is the
 * earliest possible moment and gives the owner the whole 72-hour window rather than the last 24.
 */

import Router from '@koa/router';
import { RECOVERY_THRESHOLD } from '@beanpool/core';
import { db } from '../db/db.js';
import { getMember, dispatchPushNotification } from '../state-engine.js';
import {
    openCollection,
    collectionState,
    collectionProgress,
    listReleases,
    releaseMemberFragment,
    releaseHubFragment,
    releaseSsoFragmentForIdentity,
    cancelCollection,
    openCollectionsFor,
    RecoveryReleaseError,
    type Collection,
} from '../engine/recovery-release.js';
import {
    issueNonce,
    verifyIdToken,
    getConfiguredAudiences,
    isSsoProvider,
    SsoVerificationError,
} from '../sso.js';
import type { RouteDeps } from './types.js';

/** Callsign resolution, matching idx_members_callsign_unique's predicate exactly (see keepers.ts). */
function resolveCallsign(callsign: string): { pubkey?: string; ambiguous: boolean } {
    const rows = db.prepare(`
        SELECT public_key FROM members
        WHERE LOWER(callsign) = ? AND status NOT IN ('migrated', 'pruned')
    `).all(callsign) as { public_key: string }[];
    if (rows.length > 1) return { ambiguous: true };
    return { pubkey: rows[0]?.public_key, ambiguous: false };
}

/** The human keepers on a member's current split — who D7 says to warn. */
function humanKeepersOf(ownerPubkey: string, generation: number): string[] {
    return (db.prepare(`
        SELECT holder_ref FROM recovery_shares
        WHERE owner_pubkey = ? AND generation = ? AND holder_type = 'member'
    `).all(ownerPubkey, generation) as { holder_ref: string }[]).map(r => r.holder_ref);
}

function fail(ctx: any, e: unknown): void {
    if (e instanceof RecoveryReleaseError || e instanceof SsoVerificationError) {
        ctx.status = 400;
        ctx.body = { error: (e as Error).message };
        return;
    }
    throw e;
}

export function createRecoveryCollectRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { rateLimit } = deps;

    /**
     * The session, if the caller is the device that opened it.
     *
     * `ctx.state.actor` is the cryptographically verified signer, so this is a real check rather
     * than a lookup — a collection id alone proves nothing, which is the whole point of binding
     * the session to a key instead of treating the id as a credential.
     */
    function sessionFor(ctx: any): Collection | null {
        const actor = ctx.state?.actor as string | undefined;
        const id = (ctx as any).requestBody?.collectionId;
        if (!actor || typeof id !== 'string' || !id) return null;
        const state = collectionState(id);
        if (!state) return null;
        if (state.collection.requesterEphemeralPubkey !== actor) return null;
        return state.collection;
    }

    function notMySession(ctx: any): void {
        // Deliberately identical for "no such session" and "not yours". Distinguishing them would
        // turn this into an oracle for whether a given collection id exists.
        ctx.status = 404;
        ctx.body = { error: 'No recovery session for this device.' };
    }

    /**
     * Start collecting. Signed by the recovering device's EPHEMERAL key, which is not a member of
     * anything — that is the situation, not a gap.
     */
    router.post('/api/recovery/collect', async (ctx) => {
        const requester = ctx.state?.actor as string | undefined;
        if (!requester) {
            ctx.status = 401;
            ctx.body = { error: 'A recovery session must be signed by the device requesting it.' };
            return;
        }
        // Hard-limited: this is the closest thing to an unauthenticated write in the system, since
        // anybody can mint a keypair. The per-owner cap in pruneCollectionsFor bounds storage; this
        // bounds the notification the owner receives, which is the part that could be used to
        // harass somebody.
        if (!rateLimit(ctx)) return;

        const callsign = String((ctx as any).requestBody?.callsign ?? '').trim().toLowerCase();
        if (!callsign) { ctx.status = 400; ctx.body = { error: 'Which account are you recovering?' }; return; }

        const { pubkey, ambiguous } = resolveCallsign(callsign);
        if (ambiguous) { ctx.status = 409; ctx.body = { error: 'That callsign is ambiguous on this node.' }; return; }
        if (!pubkey) {
            // Same shape a member with no split gets from openCollection, so this endpoint is no
            // sharper an oracle than the public keeper summary already is.
            ctx.status = 400;
            ctx.body = { error: 'That account has no recovery fragments to collect.' };
            return;
        }

        let collection: Collection;
        try {
            collection = openCollection(pubkey, requester);
        } catch (e) { return fail(ctx, e); }

        // The alert, at the earliest possible moment. Failure to notify must not fail the
        // recovery — a legitimate user is on the other end of this and push is best-effort — but
        // it is logged, because a notification that silently never fires would make D7 decorative.
        try {
            const targets = [pubkey, ...humanKeepersOf(pubkey, collection.generation)];
            const member = getMember(pubkey);
            dispatchPushNotification(
                targets,
                'SYSTEM',
                '🔑 Someone is recovering an account',
                `A device is trying to recover ${member?.callsign ?? 'an account'}. If this is not you, `
                + 'open BeanPool and stop it.',
                { screen: 'settings', collectionId: collection.id, kind: 'recovery_started' },
                'escrow',
            );
        } catch (e) {
            console.error('[recovery] could not notify about a new collection:', (e as Error).message);
        }

        ctx.status = 200;
        ctx.body = {
            collectionId: collection.id,
            generation: collection.generation,
            expiresAt: collection.expiresAt,
            threshold: RECOVERY_THRESHOLD,
            progress: collectionProgress(collection.id),
        };
    });

    /** How far along, and when the hub becomes available. Never includes the fragments. */
    router.post('/api/recovery/collect/status', async (ctx) => {
        const collection = sessionFor(ctx);
        if (!collection) return notMySession(ctx);
        ctx.status = 200;
        ctx.body = collectionProgress(collection.id);
    });

    /**
     * The fragments released so far.
     *
     * Separate from status on purpose: polling progress must not be a way to accumulate pieces
     * without any release rule having run. Everything returned here was released by a rule.
     */
    router.post('/api/recovery/collect/fragments', async (ctx) => {
        const collection = sessionFor(ctx);
        if (!collection) return notMySession(ctx);
        const releases = listReleases(collection.id);
        ctx.status = 200;
        ctx.body = {
            collected: releases.length,
            threshold: RECOVERY_THRESHOLD,
            enough: releases.length >= RECOVERY_THRESHOLD,
            fragments: releases.map(r => ({
                holderType: r.holderType,
                shareIndex: r.shareIndex,
                payload: r.payload,
                payloadIv: r.payloadIv,
                payloadTag: r.payloadTag,
                ephemeralPubkey: r.ephemeralPubkey,
            })),
        };
    });

    /** K2 under D7 — instant once a human has approved, otherwise 24h. */
    router.post('/api/recovery/collect/hub', async (ctx) => {
        const collection = sessionFor(ctx);
        if (!collection) return notMySession(ctx);
        try {
            releaseHubFragment(collection.id);
            ctx.status = 200;
            ctx.body = collectionProgress(collection.id);
        } catch (e) { return fail(ctx, e); }
    });

    /**
     * A sign-in nonce for the RECOVERING device.
     *
     * Separate from `/api/recovery/sso-nonce` in keepers.ts, which requires an active member. This
     * caller is by definition not one — they are trying to become one again — so the nonce is
     * bound to their ephemeral key instead. Same anti-replay property, different subject.
     */
    router.post('/api/recovery/collect/sso-nonce', async (ctx) => {
        const collection = sessionFor(ctx);
        if (!collection) return notMySession(ctx);
        if (!rateLimit(ctx)) return;
        ctx.status = 200;
        ctx.body = { nonce: issueNonce(collection.requesterEphemeralPubkey), expiresInSeconds: 600 };
    });

    /** K3 — released on a verified fresh sign-in with the provider account that is the keeper. */
    router.post('/api/recovery/collect/sso', async (ctx) => {
        const collection = sessionFor(ctx);
        if (!collection) return notMySession(ctx);
        if (!rateLimit(ctx)) return;

        const body = (ctx as any).requestBody || {};
        if (!isSsoProvider(body.provider)) {
            ctx.status = 400;
            ctx.body = { error: `'${String(body.provider)}' is not a sign-in provider this node can verify.` };
            return;
        }
        try {
            const identity = await verifyIdToken(
                body.provider,
                typeof body.idToken === 'string' ? body.idToken : '',
                getConfiguredAudiences(body.provider),
                typeof body.nonce === 'string' ? body.nonce : '',
                // The nonce was issued to the ephemeral key, so it must be consumed against it.
                collection.requesterEphemeralPubkey,
            );
            await releaseSsoFragmentForIdentity(collection.id, identity.provider, identity.sub);
            ctx.status = 200;
            ctx.body = collectionProgress(collection.id);
        } catch (e) { return fail(ctx, e); }
    });

    /**
     * D6 — a human keeper approves, signed by that keeper.
     *
     * They send the fragment already decrypted with their own key and re-wrapped to the recovering
     * device's ephemeral key. The node never sees a plaintext piece, which is what keeps "a stolen
     * database plus a compromised hub is still short of the threshold" true.
     */
    router.post('/api/recovery/approve-keeper', async (ctx) => {
        const keeper = ctx.state?.actor as string | undefined;
        if (!keeper || !getMember(keeper)) {
            ctx.status = 401;
            ctx.body = { error: 'Approving a recovery must be signed by the keeper doing it.' };
            return;
        }
        const body = (ctx as any).requestBody || {};
        const state = typeof body.collectionId === 'string' ? collectionState(body.collectionId) : null;
        if (!state) return notMySession(ctx);

        try {
            const released = releaseMemberFragment(state.collection.id, keeper, {
                payload: String(body.payload ?? ''),
                payloadIv: String(body.payloadIv ?? ''),
                payloadTag: String(body.payloadTag ?? ''),
                ephemeralPubkey: String(body.ephemeralPubkey ?? ''),
            });
            ctx.status = 200;
            ctx.body = { released: released.holderType, progress: collectionProgress(state.collection.id) };
        } catch (e) { return fail(ctx, e); }
    });

    /**
     * What a keeper needs in order to approve: whose account, and what to wrap the fragment to.
     *
     * Signed by the keeper, and answers only for collections they are actually a keeper on — so it
     * cannot be used to look up an arbitrary session.
     */
    router.post('/api/recovery/approve-keeper/context', async (ctx) => {
        const keeper = ctx.state?.actor as string | undefined;
        if (!keeper || !getMember(keeper)) { ctx.status = 401; ctx.body = { error: 'Sign in first.' }; return; }

        const body = (ctx as any).requestBody || {};
        const state = typeof body.collectionId === 'string' ? collectionState(body.collectionId) : null;
        if (!state) return notMySession(ctx);

        const share = db.prepare(`
            SELECT encrypted_share, share_iv, share_tag, ephemeral_pubkey, share_index
            FROM recovery_shares
            WHERE owner_pubkey = ? AND generation = ? AND holder_type = 'member' AND holder_ref = ?
        `).get(state.collection.ownerPubkey, state.collection.generation, keeper) as
            Record<string, unknown> | undefined;
        if (!share) return notMySession(ctx);

        const owner = getMember(state.collection.ownerPubkey);
        ctx.status = 200;
        ctx.body = {
            callsign: owner?.callsign,
            live: state.live,
            reason: state.reason,
            // What the keeper unwraps with their own key...
            fragment: {
                encryptedShare: share.encrypted_share,
                shareIv: share.share_iv,
                shareTag: share.share_tag,
                ephemeralPubkey: share.ephemeral_pubkey,
                shareIndex: share.share_index,
            },
            // ...and what they re-wrap it to.
            recipientEphemeralPubkey: state.collection.requesterEphemeralPubkey,
        };
    });

    /** R1's cheap stop — reachable by the OWNER, who is the one without the attacker's session id. */
    router.post('/api/recovery/collect/cancel', async (ctx) => {
        const owner = ctx.state?.actor as string | undefined;
        if (!owner || !getMember(owner)) { ctx.status = 401; ctx.body = { error: 'Sign in first.' }; return; }
        const id = (ctx as any).requestBody?.collectionId;
        if (typeof id !== 'string' || !id) { ctx.status = 400; ctx.body = { error: 'Which session?' }; return; }
        try {
            ctx.status = 200;
            ctx.body = { cancelled: cancelCollection(id, owner) };
        } catch (e) { return fail(ctx, e); }
    });

    /** Live recoveries against the caller's own account — what makes cancelling possible at all. */
    router.post('/api/recovery/collect/mine', async (ctx) => {
        const owner = ctx.state?.actor as string | undefined;
        if (!owner || !getMember(owner)) { ctx.status = 401; ctx.body = { error: 'Sign in first.' }; return; }
        ctx.status = 200;
        ctx.body = {
            collections: openCollectionsFor(owner).map(c => ({
                collectionId: c.id,
                generation: c.generation,
                startedAt: c.createdAt,
                expiresAt: c.expiresAt,
                progress: collectionProgress(c.id),
            })),
        };
    });

    return router;
}
