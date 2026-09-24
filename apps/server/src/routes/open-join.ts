/**
 * The open door (global profile, design §2.2): join with a one-time sign-in instead of an invite.
 *
 *   POST /api/join/sso-nonce     → { nonce, expiresInSeconds, providers, githubFlow }   (the same shape as /api/recovery/sso-nonce)
 *   POST /api/join/github/start  → { sessionId, userCode, verificationUri, expiresInSeconds, intervalSeconds }
 *   POST /api/join/github/poll   { sessionId } → { status: pending | ok | denied | expired, … }
 *   POST /api/join               { callsign, provider, idToken, nonce, recovery?: { shares } }
 *                                GitHub: { callsign, provider: 'github', proof: { sessionId }, recovery? }
 *
 * All four answer 404 "This community is invite-only." unless the profile switch `openJoin` is on (config/node-
 * profile.ts): off on every local node, on by default on the global one, and never on a node whose ledger has moved,
 * whatever the profile or an override says, so open sign-up never meets a live credit system. Read per request, so an
 * operator's override takes effect without a restart, and the first Bean that moves shuts the door.
 *
 * GitHub is run by this node (engine/github-device.ts): a GitHub token handed in proves nothing, so the joiner
 * types a code at GitHub, the node collects the answer, and the join carries the session id. The session is bound
 * to `open-join:<key>` exactly as a join nonce is, with the same consequences below.
 *
 * ## Signed by the joiner's new key, both of them
 *
 * None of these routes is on the signature bypass list. The real `requireSignature` middleware proves the caller holds
 * the key they are joining with, and the new member is `ctx.state.actor`, never a body field: the opposite of
 * `/api/invite/redeem`, which is bypassed and takes `publicKey` from the body. The middleware's spoof guard also
 * refuses a body `publicKey` that names anyone but the signer. A signed request does not need a member, so a key
 * nobody has seen before can ask; it is what makes the key the thing the sign-in is bound to.
 *
 * ## The nonce is bound to that key, for this door only
 *
 * `issueNonce` binds a nonce to a subject and `verifyIdToken` only consumes it for the same subject (sso.ts). Here
 * the subject is `open-join:<key>`: a token obtained for one key's join cannot join another key (so a token lifted
 * from a joiner cannot claim their sign-in account for somebody else's key), and a join nonce cannot be spent on
 * the recovery routes, whose nonces are bound to the bare key, nor the other way round. One nonce, one
 * verification, consumed once.
 *
 * A key a re-key replaced is refused on both (403 `key_invalidated`): it is no member any more, but every write it
 * signs is refused, so it would join as a member nobody can use (engine/open-join.ts).
 *
 * ## One sign-in, two jobs (design §2.3)
 *
 * `recovery: { shares }` enrols the SAME sign-in account as the new member's recovery keeper, in this request,
 * from the identity just verified: the body `POST /api/recovery/shares/sso` takes, minus the token and nonce this
 * request already carries. The shares are checked before the token is verified, so a malformed split is refused
 * (400) without spending the nonce. The token is never verified twice and the lookup hash is still derived by the
 * node from the verified `sub` (engine/keeper-deposit.ts). If storing the split fails the join still stands (never
 * a hard gate, and the 12 words are the key): the answer says so, and the app enrols the ordinary way.
 *
 * ## Limits
 *
 * The auth limiter (15 a minute per address) on the nonce, the GitHub start and the join; the GitHub poll on its own
 * per-address bucket instead (github-poll-rate-limit.ts), so a phone waiting on its code does not spend its
 * neighbours' auth limiter; the gateway limiter in front of everything, and on the join itself 5 new accounts an
 * hour and 20 a day per address (engine/open-join.ts). An address over its limit is told before the sign-in is
 * checked, so the nonce survives for later.
 */

import Router from '@koa/router';
import { getProfileSwitches } from '../config/node-profile.js';
import { broadcast, getMember } from '../state-engine.js';
import { clientLimiterKey } from '../client-ip.js';
import {
    issueNonce,
    verifySignIn,
    signInCredentialFrom,
    getConfiguredAudiences,
    isSsoProvider,
    ssoProviderLabel,
    SsoVerificationError,
    SsoProviderUnavailableError,
    SSO_PROVIDERS,
    type SsoIdentity,
    type SsoProvider,
} from '../sso.js';
import { startGithubSession, pollGithubSession, GITHUB_FLOW } from '../engine/github-device.js';
import { githubPollRateLimit } from '../github-poll-rate-limit.js';
import { recordFunnelEvent } from '../engine/funnel.js';
import {
    forgetOldJoinAddresses,
    openJoinAddressHash,
    openJoinHash,
    openJoinKeyInvalidated,
    openJoinLimitReached,
    registerOpenJoin,
    OPEN_JOIN_LIMITS,
    type OpenJoinOutcome,
    type OpenJoinRefusal,
} from '../engine/open-join.js';
import { checkSsoKeeperShares, storeVerifiedSsoKeeperGeneration, KeeperDepositError } from '../engine/keeper-deposit.js';
import { RecoveryShareError, type KeeperShareInput } from '../engine/recovery-shares.js';
import { BadRequest, parseShares, ssoDepositBody } from './keepers.js';
import type { RouteDeps } from './types.js';

/** The same cap `/api/invite/redeem` puts on a joining name; the wizard-on-join renames with the full rules. */
const MAX_JOIN_CALLSIGN = 20;

function joinNonceSubject(actor: string): string {
    return `open-join:${actor}`;
}

function doorOpen(): boolean {
    return getProfileSwitches().openJoin;
}

function inviteOnly(ctx: any): void {
    ctx.status = 404;
    ctx.body = { error: 'This community is invite-only.', code: 'invite_only' };
}

function unsigned(ctx: any): void {
    // The middleware refuses an unsigned POST before this runs; kept so the handler never trusts that alone.
    ctx.status = 401;
    ctx.body = { error: 'This request must be signed by the key you are joining with.' };
}

function badRequest(ctx: any, error: string, code = 'bad_request'): void {
    ctx.status = 400;
    ctx.body = { error, code };
}

const KEY_INVALIDATED = 'This key was replaced by a new one, so it can\'t join. Use the device or the 12 words that hold the new key.';

function refuse(ctx: any, reason: OpenJoinRefusal, provider: SsoProvider, window?: 'hour' | 'day'): void {
    recordFunnelEvent('open_join_failed', reason);
    const label = ssoProviderLabel(provider);
    switch (reason) {
        case 'already_member':
            ctx.status = 409;
            ctx.body = { error: 'This key is already a member of this community.', code: reason };
            return;
        case 'key_invalidated':
            ctx.status = 403;
            ctx.body = { error: KEY_INVALIDATED, code: reason };
            return;
        case 'already_joined':
            ctx.status = 409;
            ctx.body = {
                error: `This ${label} account already has a BeanPool identity here. Restore it with your 12 words or your sign-in instead.`,
                code: reason,
            };
            return;
        case 'removed':
            ctx.status = 403;
            ctx.body = {
                error: `The BeanPool identity this ${label} account joined with was removed from this community, so it can't join again.`,
                code: reason,
            };
            return;
        case 'rate_limited':
            ctx.status = 429;
            ctx.body = {
                error: window === 'day'
                    ? `Too many new accounts have joined from this network today (${OPEN_JOIN_LIMITS.perDay}). Please try again tomorrow.`
                    : `Too many new accounts have joined from this network in the last hour (${OPEN_JOIN_LIMITS.perHour}). Please try again later.`,
                code: reason,
            };
            return;
    }
}

export function createOpenJoinRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { rateLimit } = deps;

    /**
     * The key asking to start a sign-in at the door, or null once the refusal is written: the door shut,
     * unsigned, over `limit`, already a member, or a key a re-key replaced. `limit` is the auth limiter, except
     * for the GitHub poll, which is on its own per-address bucket (github-poll-rate-limit.ts): a phone polls there
     * for up to 15 minutes, and must not spend the auth limiter its neighbours on the same address sign up with.
     */
    function joiningKey(ctx: any, limit: (ctx: any) => boolean = rateLimit): string | null {
        if (!doorOpen()) { inviteOnly(ctx); return null; }
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) { unsigned(ctx); return null; }
        if (!limit(ctx)) return null;
        if (getMember(actor)) {
            ctx.status = 409;
            ctx.body = { error: 'This key is already a member of this community.', code: 'already_member' };
            return null;
        }
        if (openJoinKeyInvalidated(actor)) {
            ctx.status = 403;
            ctx.body = { error: KEY_INVALIDATED, code: 'key_invalidated' };
            return null;
        }
        return actor;
    }

    /** A GitHub start or poll at the door that did not work, in the door's own answer shape. */
    function githubFailure(ctx: any, e: unknown): void {
        if (e instanceof SsoProviderUnavailableError) {
            ctx.status = 503;
            ctx.body = { error: e.message, code: 'sign_in_unavailable' };
            return;
        }
        if (e instanceof SsoVerificationError) return badRequest(ctx, e.message, 'sign_in');
        throw e;
    }

    router.post('/api/join/sso-nonce', async (ctx) => {
        const actor = joiningKey(ctx);
        if (!actor) return;
        ctx.status = 200;
        ctx.body = {
            nonce: issueNonce(joinNonceSubject(actor)),
            expiresInSeconds: 600,
            providers: SSO_PROVIDERS,
            githubFlow: GITHUB_FLOW,
        };
    });

    router.post('/api/join/github/start', async (ctx) => {
        const actor = joiningKey(ctx);
        if (!actor) return;
        try {
            const started = await startGithubSession(joinNonceSubject(actor));
            ctx.status = 200;
            ctx.body = started;
        } catch (e) { return githubFailure(ctx, e); }
    });

    router.post('/api/join/github/poll', async (ctx) => {
        const actor = joiningKey(ctx, githubPollRateLimit);
        if (!actor) return;
        const sessionId = (ctx as any).requestBody?.sessionId;
        try {
            const polled = await pollGithubSession(typeof sessionId === 'string' ? sessionId : '', joinNonceSubject(actor));
            ctx.status = 200;
            ctx.body = polled;
        } catch (e) { return githubFailure(ctx, e); }
    });

    router.post('/api/join', async (ctx) => {
        if (!doorOpen()) return inviteOnly(ctx);
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) return unsigned(ctx);
        if (!rateLimit(ctx)) return;

        const body = (ctx as any).requestBody || {};
        const provider = body.provider;
        if (!isSsoProvider(provider)) {
            return badRequest(ctx, `'provider' must be one of: ${SSO_PROVIDERS.join(', ')}.`);
        }
        const credential = signInCredentialFrom(body);
        const nonce = typeof body.nonce === 'string' ? body.nonce : '';
        if (provider === 'github') {
            // The session this node ran; a GitHub token, if that is what came, is refused by verifySignIn.
            if (!credential.sessionId && !credential.idToken) return badRequest(ctx, "'proof.sessionId' is required for GitHub.");
        } else {
            if (!credential.idToken) return badRequest(ctx, "'idToken' is required.");
            if (!nonce) return badRequest(ctx, "'nonce' is required.");
        }
        const callsign = typeof body.callsign === 'string' ? body.callsign.trim().slice(0, MAX_JOIN_CALLSIGN).trim() : '';
        if (callsign.length < 2) return badRequest(ctx, 'Please choose a name of at least 2 characters.');

        let recoveryShares: KeeperShareInput[] | null = null;
        if (body.recovery !== undefined && body.recovery !== null) {
            try {
                recoveryShares = parseShares(body.recovery?.shares);
                checkSsoKeeperShares(provider, actor, recoveryShares);
            } catch (e) {
                if (e instanceof BadRequest || e instanceof KeeperDepositError) {
                    return badRequest(ctx, `The recovery keeper could not be read: ${e.message}`, 'recovery_invalid');
                }
                throw e;
            }
        }

        recordFunnelEvent('open_join_attempt', provider);

        // Refused before the sign-in is checked, so these never spend the nonce. registerOpenJoin checks all of them
        // again with its writes, and those are the checks that decide.
        if (getMember(actor)) return refuse(ctx, 'already_member', provider);
        if (openJoinKeyInvalidated(actor)) return refuse(ctx, 'key_invalidated', provider);
        forgetOldJoinAddresses();
        const ipHash = openJoinAddressHash(clientLimiterKey(ctx));
        const window = openJoinLimitReached(ipHash);
        if (window) return refuse(ctx, 'rate_limited', provider, window);

        let identity: SsoIdentity;
        try {
            identity = await verifySignIn(
                provider,
                credential,
                getConfiguredAudiences(provider),
                nonce,
                joinNonceSubject(actor),
            );
        } catch (e) {
            // An SsoProviderUnavailableError is also an SsoVerificationError, so it is ruled out explicitly.
            if (e instanceof SsoVerificationError && !(e instanceof SsoProviderUnavailableError)) {
                recordFunnelEvent('open_join_failed', 'sign_in');
                ctx.status = 401;
                ctx.body = { error: e.message, code: 'sign_in' };
                return;
            }
            // Not the member's sign-in: the provider could not be asked (its keys or its user endpoint failed,
            // came back unusable, or timed out). The nonce was not spent, so the same sign-in can try again.
            console.warn('[OpenJoin] sign-in could not be checked:', (e as Error)?.message || e);
            recordFunnelEvent('open_join_failed', 'sign_in_unavailable');
            ctx.status = 503;
            ctx.body = { error: `${ssoProviderLabel(provider)} sign-in could not be checked right now. Please try again in a minute.`, code: 'sign_in_unavailable' };
            return;
        }

        let outcome: OpenJoinOutcome;
        try {
            outcome = registerOpenJoin(broadcast, {
                publicKey: actor,
                callsign,
                provider: identity.provider,
                joinHash: openJoinHash(identity.provider, identity.sub),
                ipHash,
            });
        } catch (e) {
            // Nothing was kept: the member row and the open_joins row roll back together (engine/open-join.ts). The
            // exception's text names tables and constraints, so it goes to the log and never into the answer.
            console.error('[OpenJoin] join could not be recorded:', (e as Error)?.message || e);
            recordFunnelEvent('open_join_failed', 'join_failed');
            ctx.status = 503;
            ctx.body = { error: 'Your join could not be completed, and nothing was saved. Please sign in and try again in a minute.', code: 'join_failed' };
            return;
        }
        if (!outcome.ok) return refuse(ctx, outcome.reason, identity.provider, outcome.window);

        let recovery: Record<string, unknown> | undefined;
        if (recoveryShares) {
            try {
                const result = await storeVerifiedSsoKeeperGeneration(identity, actor, recoveryShares);
                recovery = { enrolled: true, ...ssoDepositBody(actor, result) };
            } catch (e) {
                const known = e instanceof KeeperDepositError || e instanceof RecoveryShareError || e instanceof SsoVerificationError;
                if (!known) console.warn('[OpenJoin] recovery keeper not stored:', (e as Error)?.message || e);
                recovery = { enrolled: false, error: known ? (e as Error).message : 'The recovery keeper could not be stored.' };
            }
        }

        ctx.status = 200;
        ctx.body = { success: true, member: outcome.member, provider: identity.provider, ...(recovery ? { recovery } : {}) };
    });

    return router;
}
