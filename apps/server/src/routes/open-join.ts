/**
 * The open door (global profile, design §2.2): join with a one-time sign-in instead of an invite.
 *
 *   POST /api/join/sso-nonce   → { nonce, expiresInSeconds, providers }   (the same shape as /api/recovery/sso-nonce)
 *   POST /api/join             { callsign, provider, idToken, nonce, recovery?: { shares } }
 *
 * Both answer 404 "This community is invite-only." unless the profile switch `openJoin` is on (config/node-
 * profile.ts): off on every local node, on by default on the global one. Read per request, so an operator's
 * override takes effect without a restart.
 *
 * ## Signed by the joiner's new key, both of them
 *
 * Neither route is on the signature bypass list. The real `requireSignature` middleware proves the caller holds
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
 * The auth limiter (15 a minute per address) on both, the gateway limiter in front of everything, and on the join
 * itself 5 new accounts an hour and 20 a day per address (engine/open-join.ts). An address over its limit is told
 * before the sign-in is checked, so the nonce survives for later.
 */

import Router from '@koa/router';
import { getProfileSwitches } from '../config/node-profile.js';
import { broadcast, getMember } from '../state-engine.js';
import { clientLimiterKey } from '../client-ip.js';
import {
    issueNonce,
    verifyIdToken,
    getConfiguredAudiences,
    isSsoProvider,
    ssoProviderLabel,
    SsoVerificationError,
    SsoProviderUnavailableError,
    SSO_PROVIDERS,
    type SsoIdentity,
    type SsoProvider,
} from '../sso.js';
import { recordFunnelEvent } from '../engine/funnel.js';
import {
    forgetOldJoinAddresses,
    openJoinAddressHash,
    openJoinHash,
    openJoinLimitReached,
    registerOpenJoin,
    OPEN_JOIN_LIMITS,
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

function refuse(ctx: any, reason: OpenJoinRefusal, provider: SsoProvider, window?: 'hour' | 'day'): void {
    recordFunnelEvent('open_join_failed', reason);
    const label = ssoProviderLabel(provider);
    switch (reason) {
        case 'already_member':
            ctx.status = 409;
            ctx.body = { error: 'This key is already a member of this community.', code: reason };
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

    router.post('/api/join/sso-nonce', async (ctx) => {
        if (!doorOpen()) return inviteOnly(ctx);
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) return unsigned(ctx);
        if (!rateLimit(ctx)) return;
        if (getMember(actor)) {
            ctx.status = 409;
            ctx.body = { error: 'This key is already a member of this community.', code: 'already_member' };
            return;
        }
        ctx.status = 200;
        ctx.body = {
            nonce: issueNonce(joinNonceSubject(actor)),
            expiresInSeconds: 600,
            providers: SSO_PROVIDERS,
        };
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
        if (typeof body.idToken !== 'string' || !body.idToken) return badRequest(ctx, "'idToken' is required.");
        if (typeof body.nonce !== 'string' || !body.nonce) return badRequest(ctx, "'nonce' is required.");
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

        // Refused before the sign-in is checked, so these never spend the nonce. registerOpenJoin checks all three
        // again with its writes, and those are the checks that decide.
        if (getMember(actor)) return refuse(ctx, 'already_member', provider);
        forgetOldJoinAddresses();
        const ipHash = openJoinAddressHash(clientLimiterKey(ctx));
        const window = openJoinLimitReached(ipHash);
        if (window) return refuse(ctx, 'rate_limited', provider, window);

        let identity: SsoIdentity;
        try {
            identity = await verifyIdToken(
                provider,
                body.idToken,
                getConfiguredAudiences(provider),
                body.nonce,
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

        const outcome = registerOpenJoin(broadcast, {
            publicKey: actor,
            callsign,
            provider: identity.provider,
            joinHash: openJoinHash(identity.provider, identity.sub),
            ipHash,
        });
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
