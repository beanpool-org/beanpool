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
 * Not when a session opens, any more (defence review FABLE-sec-sso finding 5, 2026-10-01): while a session opened for a
 * typed name, that alert was a push anybody with a member's name could send, as often as the auth limiter allowed. Now a
 * session opens only for an account a verified sign-in found, with that sign-in's release in the same request (the find,
 * below), so the release's alert is the one. The owner still sees how many sessions are live in the app
 * (`/api/recovery/collect/mine`, the recovery banner) and can stop them all there, in one call (`/collect/cancel`).
 *
 * ## What leaves, and when
 *
 * A released copy is handed over only while its session is live (finding 4), and sealed to the session's throwaway key
 * when the device asks (finding 2, `seal` in `/collect/fragments`; @beanpool/core sealReleaseToDevice), so the bytes in
 * transit or in a log are nothing without that key.
 *
 * ## Finding the account from the sign-in alone (design DESIGN-recovery-no-callsign-fable.md §3, slice S0)
 *
 * `POST /api/recovery/find-nonce` and `POST /api/recovery/find` take a sign-in and answer the accounts it protects here, by
 * name and key (engine/recovery-find.ts): only the holder of that sign-in gets a match, so an empty list tells the caller
 * only that their own sign-in has no account here. The find holds the verified sign-in for 5 minutes, keyed by the
 * restore's throwaway key, and `POST /api/recovery/collect {candidatePublicKey}` opens the session for the account picked
 * and releases its copy in the same request, through the per-row lookup-hash proof (engine/recovery-release.ts
 * releaseSsoFragmentForIdentity): the find's index is never the proof.
 *
 * No account is found by a typed name (S3, in the same release as the S2 phone: Marty, 9 Nov). The name routes are
 * deleted: the public lookup by name, a collect by name, `/collect/sso-nonce` and `/collect/sso`. An app from before S2
 * that still asks one of those addresses is told so in words (nameRoutesGone, below).
 */

import Router from '@koa/router';

import type { Context, Next } from 'koa';
import { isSingleBlobSso, KEEPER_ALG_RELEASE, sealReleaseToDevice, word } from '@beanpool/core';
import { getActingMember, dispatchPushNotification } from '../state-engine.js';
import {
    openCollection,
    discardUnreleasedCollection,
    collectionState,
    collectionProgress,
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
import { requireRecoverySealKey } from '../services/recovery-seal-key.js';
import { assertPlainTablesWritable, StandbyLedgerError } from '../config/node-role.js';
import { FindBusy, findAccountsBySignIn, holdFind, isRestorableMember, takeFindHold } from '../engine/recovery-find.js';
import { recoverySealFailure, signInFailure } from './keepers.js';
import type { RouteDeps } from './types.js';

/**
 * What an app from before S2 hears at the address of a name route S3 deleted (design DESIGN-recovery-no-callsign-fable.md
 * §3, §4): 404 and this sentence, code `no_restore_by_name`. A phone from 1.3.4 asks the lookup first and reads any answer
 * but a list as "Can't reach the community right now", which nothing can change in it (design §4: S3 reaches nodes only
 * with the S2 phone's release); the sentence is for whoever reads the answer itself, and for an older phone already past
 * the lookup when its community updated, which shows a refusal's words.
 */
export const NO_RESTORE_BY_NAME = word('This community no longer finds an account by its name. Update the app to restore with your sign-in, or use your 12 words.');
export const NO_RESTORE_BY_NAME_CODE = 'no_restore_by_name';

/**
 * The deleted name routes' addresses, as their apps asked them: the lookup by a typed name (unsigned GET, and the HEAD the
 * router answered with it), and a session's sign-in nonce and release (signed POSTs).
 */
const NAME_ROUTES_GONE: readonly { methods: readonly string[]; path: RegExp }[] = [
    { methods: ['GET', 'HEAD'], path: /^\/api\/recovery\/lookup\/[^/]+\/?$/ },
    { methods: ['POST'], path: /^\/api\/recovery\/collect\/(sso-nonce|sso)\/?$/ },
];

/**
 * Koa middleware, mounted before the private preview's gate and the signature middleware (https-server.ts): each address
 * in NAME_ROUTES_GONE answers 404 with NO_RESTORE_BY_NAME in JSON, never a 401 for a signature its app never sent (the
 * lookup was public), the preview's sentence, or an empty "Not Found". Nothing is read or written. Conversion code (no
 * conversion code without saying so, Marty 10 Nov): it goes once no phone the communities let in is older than the S2
 * build.
 */
export function nameRoutesGone() {
    return async function nameRoutesGoneMiddleware(ctx: Context, next: Next): Promise<void> {
        if (!NAME_ROUTES_GONE.some((r) => r.methods.includes(ctx.method) && r.path.test(ctx.path))) return next();
        ctx.status = 404;
        ctx.body = { error: NO_RESTORE_BY_NAME, code: NO_RESTORE_BY_NAME_CODE };
    };
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
    // A standby makes no release (config/node-role.ts): 409 `standby`, as its gate answers (routes/standby-ledger-gate.ts).
    if (e instanceof StandbyLedgerError) {
        ctx.status = 409;
        ctx.body = { error: e.message, code: e.code };
        return;
    }
    // One scan at a time for copies made before the find hash (engine/recovery-find.ts): 503 `find_busy`, sign in again in a minute.
    if (e instanceof FindBusy) {
        ctx.status = 503;
        ctx.body = { error: e.message, code: e.code };
        return;
    }
    if (e instanceof RecoveryReleaseError) {
        ctx.status = 400;
        ctx.body = { error: (e as Error).message };
        return;
    }
    // Handle unexpected errors with 500 status and JSON body instead of unhandled route exception
    const msg = e instanceof Error ? e.message : String(e);
    ctx.status = 500;
    ctx.body = { error: msg || word('Recovery operation failed') };
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
        ctx.body = { error: word('No recovery session for this device.') };
    }

    /**
     * Start collecting, for the account a find named (design §3): `candidatePublicKey` must be one the find this throwaway
     * key signed named, inside its 5-minute hold. Then the session opens and, in the same request, the hold's sign-in
     * releases the copy through the release's own per-row scrypt proof (releaseSsoFragmentForIdentity), never the find's
     * index; the owner is told once, and the hold is spent. A name in the body is not read: no account is found by one.
     *
     * Signed by the recovering device's EPHEMERAL key, which is not a member of anything — that is the situation, not a
     * gap. A standby, or a server without its key, refuses before the hold is touched, so the member's is kept for when
     * the main server, or the key, answers. A release that does not happen leaves no session behind.
     */
    router.post('/api/recovery/collect', async (ctx) => {
        const requester = ctx.state?.actor as string | undefined;
        if (!requester) {
            ctx.status = 401;
            ctx.body = { error: 'A recovery session must be signed by the device requesting it.' };
            return;
        }
        // Hard-limited: anybody can mint a keypair, and a request with a hold runs a scrypt proof. The cap in
        // pruneCollectionsFor bounds the sessions an owner's sign-in leaves idle.
        if (!rateLimit(ctx, 'sign-in-recovery')) return;

        // The account the device picked from its find: named so the middleware's spoof check reads it as someone else's
        // key, as it is (the device signs with a throwaway key).
        const publicKey = (ctx as any).requestBody?.candidatePublicKey;
        if (typeof publicKey !== 'string' || !publicKey) {
            ctx.status = 400;
            ctx.body = { error: word('Which account are you recovering?') };
            return;
        }
        let collection: Collection | null = null;
        try {
            assertPlainTablesWritable();
            requireRecoverySealKey();
            // The hold first: without one, every key gets this one answer, so no caller learns whether a key is a member's.
            const hold = takeFindHold(requester, publicKey);
            if (!hold) {
                ctx.status = 400;
                ctx.body = { error: word("Sign in with your account's sign-in first.") };
                return;
            }
            // Still one a restore may bring back (the find asked the same): not pruned, migrated or made a visitor since.
            if (!isRestorableMember(publicKey)) {
                ctx.status = 400;
                ctx.body = { error: word('That account has no recovery fragments to collect.') };
                return;
            }
            collection = openCollection(publicKey, requester);
            await releaseSsoFragmentForIdentity(collection.id, hold.provider, hold.sub);
            // A session opened by this request: its release is its first, so the owner hears it once.
            notifySeedReleased(collection, hold.provider);
        } catch (e) {
            if (collection) discardUnreleasedCollection(collection.id);
            return fail(ctx, e);
        }
        const progress = collectionProgress(collection.id);
        ctx.status = 200;
        ctx.body = {
            collectionId: collection.id,
            generation: collection.generation,
            expiresAt: collection.expiresAt,
            threshold: progress?.threshold ?? 1,
            progress,
        };
    });

    /**
     * A sign-in nonce for finding the account (design §3): bound to the restore's throwaway key, with no session yet: the
     * find comes first. Separate from `/api/recovery/sso-nonce` in keepers.ts, which a member's own Connect asks. A standby
     * refuses it (its gate), before the provider's sheet opens.
     */
    router.post('/api/recovery/find-nonce', async (ctx) => {
        const requester = ctx.state?.actor as string | undefined;
        if (!requester) {
            ctx.status = 401;
            ctx.body = { error: 'A recovery session must be signed by the device requesting it.' };
            return;
        }
        if (!rateLimit(ctx, 'sign-in-recovery')) return;
        ctx.status = 200;
        ctx.body = {
            nonce: issueNonce(requester),
            expiresInSeconds: 600,
            // The id a browser puts in its request to each provider it leaves the page for (sso.ts webClientId).
            clientIds: webClientIds(),
        };
    });

    /**
     * The accounts a verified sign-in protects here, by name and key (engine/recovery-find.ts): `{ accounts }`, empty when
     * there are none, which tells the caller only about their own sign-in. Several when one sign-in protects several
     * accounts; the member picks, and nothing is released for the others. The verified sign-in is held for the collect
     * (holdFind). A server without its key refuses before the sign-in is checked, so the device keeps its nonce.
     */
    router.post('/api/recovery/find', async (ctx) => {
        const requester = ctx.state?.actor as string | undefined;
        if (!requester) {
            ctx.status = 401;
            ctx.body = { error: 'A recovery session must be signed by the device requesting it.' };
            return;
        }
        if (!rateLimit(ctx, 'sign-in-recovery')) return;
        const body = (ctx as any).requestBody || {};
        if (!isSsoProvider(body.provider)) {
            ctx.status = 400;
            // At most 40 characters of what was sent, as distance-query.ts writes a value it could not read: a refusal is
            // no place for whatever a stranger chose to send.
            ctx.body = { error: `'${String(body.provider).slice(0, 40)}' is not a sign-in provider this node can verify.` };
            return;
        }
        try {
            requireRecoverySealKey();
            const identity = await verifySignIn(
                body.provider,
                signInCredentialFrom(body),
                getConfiguredAudiences(body.provider),
                typeof body.nonce === 'string' ? body.nonce : '',
                requester,
            );
            const accounts = await findAccountsBySignIn(identity.provider, identity.sub);
            holdFind(requester, identity.provider, identity.sub, accounts);
            ctx.status = 200;
            ctx.body = { accounts };
        } catch (e) { return fail(ctx, e); }
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
        if (!owner || !getActingMember(owner)) { ctx.status = 401; ctx.body = { error: word('Sign in first.') }; return; }
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
        if (!owner || !getActingMember(owner)) { ctx.status = 401; ctx.body = { error: word('Sign in first.') }; return; }
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
