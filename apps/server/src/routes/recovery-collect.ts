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
 * ## When the owner is told
 *
 * When a sign-in releases their copy (notifySeedReleased): the owner learns it worked. That is the moment that
 * matters, since a sign-in releases the copy seconds after the session opens.
 *
 * Not when a session opens, any more (defence review FABLE-sec-sso finding 5, 2026-10-01). Opening one is
 * unauthenticated by necessity, so that alert was a push anybody with a callsign could send a member, as often as the
 * auth limiter allowed, and it defended nothing that remains: it was there for D7 and R1, the friend tier's colluding
 * keepers, which is scrapped. What an open with no sign-in can still reach is the hub's piece of a legacy two-layer copy
 * after 24 hours, half a seed, useless alone. The owner still sees how many sessions are live in the app
 * (`/api/recovery/collect/mine`, the recovery banner) and can stop them all there, in one call (`/collect/cancel`).
 *
 * ## What leaves, and when
 *
 * A released copy is handed over only while its session is live (finding 4), and sealed to the session's throwaway key
 * when the device asks (finding 2, `seal` in `/collect/fragments`; @beanpool/core sealReleaseToDevice), so the bytes in
 * transit or in a log are nothing without that key.
 */

import Router from '@koa/router';

import { db } from '../db/db.js';
import { isSingleBlobSso, KEEPER_ALG_RELEASE, sealReleaseToDevice } from '@beanpool/core';
import { getActingMember, dispatchPushNotification } from '../state-engine.js';
import {
    openCollection,
    collectionState,
    collectionProgress,
    listReleases,
    releasesForLiveSession,
    releaseHubFragment,
    releaseSsoFragmentForIdentity,
    cancelCollection,
    cancelAllCollectionsFor,
    countOpenCollectionsFor,
    openCollectionsFor,
    pruneCollectionsFor,
    RecoveryReleaseError,
    type Collection,
} from '../engine/recovery-release.js';
import {
    issueNonce,
    verifySignIn,
    signInCredentialFrom,
    getConfiguredAudiences,
    isSsoProvider,
    ssoProviderLabel,
    SsoVerificationError,
    webClientIds,
    type SsoProvider,
} from '../sso.js';
import { isSingleBlobSsoStored, requireRecoverySealKey } from '../services/recovery-seal-key.js';
import { recoverySealFailure, signInFailure } from './keepers.js';
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


/**
 * The one alert: a sign-in has just RELEASED this member's sign-in fragment. For a single-blob keeper
 * that fragment is the whole seed; for a two-layer one it makes the hub's piece available at once.
 * Nothing is pushed when a session opens (see the header), so this is the first the owner hears from a
 * push, and it says it worked: an owner who did not do it learns their key is out and needs moving,
 * which stopping the session no longer fixes. Plain words, and nothing of the fragment in it.
 */
function notifySeedReleased(collection: Collection, provider: SsoProvider): void {
    try {
        const label = ssoProviderLabel(provider);
        dispatchPushNotification(
            [collection.ownerPubkey],
            'SYSTEM',
            '🔑 Your account was just restored',
            `Your account was just restored with ${label} on another device. If that wasn't you, contact `
            + `your community's admin now to move your account to a new key, and secure your ${label} account.`,
            { screen: 'settings', collectionId: collection.id, kind: 'recovery_released' },
            'recovery',
            'account.restored',
        );
    } catch (e) {
        console.error('[recovery] could not notify about a released fragment:', (e as Error).message);
    }
}

/** How many of the owner's live sessions `/collect/mine` lists: the newest, beside the count of all of them. */
export const MINE_LISTED = 3;

function fail(ctx: any, e: unknown): void {
    // A sign-in first: a provider that could not be asked is 503, try again, not a refused sign-in (signInFailure).
    if (e instanceof SsoVerificationError) return signInFailure(ctx, e);
    // A server that cannot open the copy (its recovery-seal key is missing, or the copy is another key's): 503, the sentence.
    if (recoverySealFailure(ctx, e)) return;
    if (e instanceof RecoveryReleaseError) {
        ctx.status = 400;
        ctx.body = { error: (e as Error).message };
        return;
    }
    // Handle unexpected errors with 500 status and JSON body instead of unhandled route exception
    const msg = e instanceof Error ? e.message : String(e);
    ctx.status = 500;
    ctx.body = { error: msg || 'Recovery operation failed' };
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
        // anybody can mint a keypair. This bounds the sessions in their sign-in window, which nothing evicts; the cap
        // in pruneCollectionsFor bounds the idle ones.
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
        // No push to the owner here: anybody can open one (see the header). They are told when a sign-in releases the
        // copy (notifySeedReleased), and see live sessions in the app.

        const progress = collectionProgress(collection.id);
        const ssoRows = db.prepare(`
            SELECT kdf_params FROM recovery_shares
            WHERE owner_pubkey = ? AND generation = ? AND holder_type = 'sso'
        `).all(pubkey, collection.generation) as { kdf_params: string | null }[];
        // Stored rows are wrapped; the client's scheme is readable beside the wrap without the key.
        const isSingleBlob = ssoRows.length > 0 && ssoRows.every(r => isSingleBlobSsoStored(r.kdf_params));
        const defaultThreshold = isSingleBlob ? 1 : 2;
        const threshold = progress?.threshold ?? defaultThreshold;
        ctx.status = 200;
        ctx.body = {
            collectionId: collection.id,
            generation: collection.generation,
            expiresAt: collection.expiresAt,
            threshold,
            progress,
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
     * The fragments released so far, while the session is live (finding 4: engine releasesForLiveSession).
     *
     * Separate from status on purpose: polling progress must not be a way to accumulate pieces
     * without any release rule having run. Everything returned here was released by a rule.
     *
     * `seal: 'x25519-xc20p-release-v1'` (core KEEPER_ALG_RELEASE) in the signed request asks for each copy sealed to the
     * session's throwaway key (finding 2): what crosses the wire then opens only with that key's private half, which
     * never leaves the device. Both apps ask. A request without it is an app from before the seal, and gets each copy
     * as stored, so its restores keep working; it is that app's own traffic, signed by the session's key, so nobody
     * can take the seal off another device's request.
     */
    router.post('/api/recovery/collect/fragments', async (ctx) => {
        const collection = sessionFor(ctx);
        if (!collection) return notMySession(ctx);
        const seal = (ctx as any).requestBody?.seal;
        if (seal !== undefined && seal !== null && seal !== KEEPER_ALG_RELEASE) {
            ctx.status = 400;
            ctx.body = { error: `This node seals a released copy only as '${KEEPER_ALG_RELEASE}'.` };
            return;
        }
        let releases;
        try {
            releases = releasesForLiveSession(collection.id);
        } catch (e) { return fail(ctx, e); }
        const progress = collectionProgress(collection.id);
        const isSingleBlob = releases.some(r => r.holderType === 'sso' && isSingleBlobSso(r.kdfParams));
        const defaultThreshold = isSingleBlob ? 1 : 2;
        const threshold = progress?.threshold ?? defaultThreshold;
        let fragments;
        try {
            fragments = releases.map(r => {
                const listed = {
                    holderType: r.holderType,
                    shareIndex: r.shareIndex,
                    payload: r.payload,
                    payloadIv: r.payloadIv,
                    payloadTag: r.payloadTag,
                    ephemeralPubkey: r.ephemeralPubkey,
                    kdfParams: r.kdfParams,
                };
                if (!seal) return listed;
                const sealed = sealReleaseToDevice(
                    { encryptedShare: r.payload, shareIv: r.payloadIv, shareTag: r.payloadTag, kdfParams: r.kdfParams },
                    collection.requesterEphemeralPubkey,
                    { collectionId: collection.id, holderType: r.holderType },
                );
                return {
                    ...listed,
                    payload: sealed.encryptedShare,
                    payloadIv: sealed.shareIv,
                    payloadTag: sealed.shareTag,
                    ephemeralPubkey: sealed.ephemeralPubkey ?? null,
                    kdfParams: sealed.kdfParams,
                };
            });
        } catch (e) { return fail(ctx, e); }
        ctx.status = 200;
        ctx.body = {
            collected: releases.length,
            threshold,
            enough: progress?.enough ?? (releases.length >= threshold),
            fragments,
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
        ctx.body = {
            nonce: issueNonce(collection.requesterEphemeralPubkey),
            expiresInSeconds: 600,
            // The id a browser puts in its request to each provider it leaves the page for (sso.ts webClientId).
            clientIds: webClientIds(),
        };
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
            // Every release is recorded wrapped, so a server without its recovery-seal key refuses before the sign-in
            // is checked: the device keeps its nonce for when the key is back.
            requireRecoverySealKey();
            const identity = await verifySignIn(
                body.provider,
                signInCredentialFrom(body),
                getConfiguredAudiences(body.provider),
                typeof body.nonce === 'string' ? body.nonce : '',
                // The nonce was issued to the ephemeral key, so it must be spent against it.
                collection.requesterEphemeralPubkey,
            );
            const alreadyReleased = new Set(listReleases(collection.id).map(r => r.shareId));
            const released = await releaseSsoFragmentForIdentity(collection.id, identity.provider, identity.sub);
            // Once per fragment released: a retry of a request that already released it tells nobody twice.
            if (!alreadyReleased.has(released.shareId)) notifySeedReleased(collection, identity.provider);
            ctx.status = 200;
            ctx.body = collectionProgress(collection.id);
        } catch (e) { return fail(ctx, e); }
    });

    /**
     * R1's cheap stop — reachable by the OWNER, who is the one without the attacker's session id.
     *
     * Stops EVERY live session against the owner's account, in one call (engine cancelAllCollectionsFor), whether or
     * not it names one. Strangers decide how many sessions there are (anybody can open one, and nothing evicts one in
     * its sign-in window), so a Stop that took them one request each ran into the owner's own rate limits a few
     * hundred in and left the rest live while the app said "all cancelled" (PR #1456 deciding review). An app from
     * before this names one session per request: the first request stops them all, so its words are true too.
     *
     * A named session is still checked: it must be the caller's own (400 otherwise, as before). The answer says what
     * this request did: `cancelled` (it stopped at least one session, named or not), `stopped` (how many), and `live`
     * (how many are live now: 0 unless a new one opened since).
     */
    router.post('/api/recovery/collect/cancel', async (ctx) => {
        const owner = ctx.state?.actor as string | undefined;
        // A visitor's row has no account here being recovered, as a key with no row has none (getActingMember).
        if (!owner || !getActingMember(owner)) { ctx.status = 401; ctx.body = { error: 'Sign in first.' }; return; }
        const id = (ctx as any).requestBody?.collectionId;
        if (id !== undefined && id !== null && (typeof id !== 'string' || !id)) {
            ctx.status = 400; ctx.body = { error: 'Which session?' }; return;
        }
        try {
            // The named one first, so a session that is somebody else's, or none at all, is refused before anything stops.
            const named = typeof id === 'string' ? cancelCollection(id, owner) : null;
            const rest = cancelAllCollectionsFor(owner);
            const stopped = rest + (named ? 1 : 0);
            ctx.status = 200;
            ctx.body = { cancelled: stopped > 0, stopped, live: countOpenCollectionsFor(owner) };
        } catch (e) { return fail(ctx, e); }
    });

    /**
     * Live recoveries against the caller's own account — what makes cancelling possible at all.
     *
     * `count` is how many, and `collections` the newest few of them ({@link MINE_LISTED}), never all: strangers decide
     * how many there are, and both apps poll this every ~30 s while open. Listing every one, with its progress, sent
     * 624 KB a poll at 2,100 sessions and held the node for 0.7 s at 20,000 (PR #1456 deciding review). Both banners
     * show the count and when the newest started; an app from before `count` shows how many it was sent.
     *
     * Sessions past their sign-in window are pruned first (engine pruneCollectionsFor, a batch at a time), so what the
     * owner sees is current; the node-wide sweep (sweepRecoveryCollections) retires the rest of a pile, and retires it
     * for an owner who never opens the app too.
     */
    router.post('/api/recovery/collect/mine', async (ctx) => {
        const owner = ctx.state?.actor as string | undefined;
        if (!owner || !getActingMember(owner)) { ctx.status = 401; ctx.body = { error: 'Sign in first.' }; return; }
        try {
            pruneCollectionsFor(owner);
        } catch (e) {
            // A read must not fail for its housekeeping: the next open or read prunes again.
            console.error('[recovery] could not prune recovery sessions on read:', (e as Error).message);
        }
        ctx.status = 200;
        ctx.body = {
            count: countOpenCollectionsFor(owner),
            collections: openCollectionsFor(owner, MINE_LISTED).map(c => ({
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
