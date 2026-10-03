/**
 * Claiming a community that has no owner yet (claim-code.ts). Two routes, both public:
 *
 *   GET  /api/local/claim  whether the node is unclaimed, and if so the waiting code's public id and the community's
 *                          name, for the phone to show and to sign.
 *   POST /api/local/claim  { publicKey, callsign, code, codeId, signedFor, signature }: `signature` is the key's over
 *                          0xFF ‖ `beanpool-claim/1\n<signedFor>\n<codeId>` (@beanpool/core claimText), the host the
 *                          phone reached this node at and the code's id. The code travels beside it, never signed in.
 *
 * What binds a claim to this node: the code id (a fresh one per code), and the host. On a node that knows its names the
 * host must be one of them (engine/member-signature.ts audienceRefusal). On a node that knows none, audienceRefusal lets
 * any host through until the switch; a claim there must also name the host this request was sent to (its Host header),
 * so a signature made for another server is refused here.
 *
 * The signature is checked before the code, and only a request that will cost an scrypt is braked (claim-code.ts
 * admitClaimCheck). Once the node has an owner every claim is refused, except the same key retrying the claim that made
 * it owner (a lost answer): that is answered as the claim was, and changes nothing.
 *
 * Under /api/local/, so the signed-request middleware never sees these (https-server.ts isSignatureBypassed): the
 * statement's own signature is the proof.
 */
import Router from '@koa/router';
import { claimText } from '@beanpool/core';
import type { RouteDeps } from './types.js';
import { clientLimiterKey } from '../client-ip.js';
import { logAddressTag } from '../log-address.js';
import { getLocalConfig } from '../config/local-config.js';
import { nodeHasOwner } from '../engine/node-roles.js';
import { verifyStatementSignature } from '../engine/member-signature.js';
import { audienceStanding, normalizeAddress } from '../engine/own-addresses.js';
import {
    admitClaimCheck, claimCodeMatches, claimedByThisKey, claimKey, claimNode, isClaimCodeId, isClaimCodeShape, pendingClaim,
} from '../claim-code.js';
import { getMember } from '../state-engine.js';
import { logger } from '../logger.js';

export function createNodeClaimRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const bodyOf = (ctx: any) => (ctx as any).requestBody || (ctx.request as any)?.body || {};
    const refuse = (ctx: any, status: number, code: string, error: string) => {
        ctx.status = status;
        ctx.body = { error, code };
    };

    router.get('/api/local/claim', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (nodeHasOwner()) {
            ctx.body = { unclaimed: false };
            return;
        }
        const config = getLocalConfig();
        const pending = pendingClaim(config);
        ctx.body = {
            unclaimed: true,
            codeId: pending ? pending.id : null,
            communityName: config.communityName || config.callsign || null,
        };
    });

    router.post('/api/local/claim', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const body = bodyOf(ctx);
        const key = claimKey(body.publicKey);
        if (!key) return refuse(ctx, 400, 'claim_bad_key', 'A member key (64 lower-case hex digits) is needed to claim.');
        const codeId = body.codeId;
        if (!isClaimCodeId(codeId)) return refuse(ctx, 400, 'claim_bad_request', 'The claim code id is missing or not one this node makes.');
        const source = clientLimiterKey(ctx as any);

        const verify = () => {
            const signed = verifyStatementSignature({
                signature: String(body.signature ?? ''),
                pubKeyHex: key,
                boundText: (host) => claimText(host, codeId),
                signedFor: body.signedFor,
                oldTexts: [],
            });
            if (!signed.ok) return signed;
            // A node that knows none of its names takes any host above (audienceRefusal). The claim must still name the
            // host this request came to, so a statement signed for another server is no claim here.
            const named = String(body.signedFor);
            if (audienceStanding(named) === 'unconfigured' && named !== normalizeAddress(ctx.request.host)) {
                return { ok: false as const, status: 421, error: 'This claim was signed for another server.', code: 'wrong_community' };
            }
            return signed;
        };

        const config = getLocalConfig();
        if (nodeHasOwner()) {
            const signed = verify();
            if (signed.ok && config.claim?.id === codeId && claimedByThisKey(key, config)) {
                const member = getMember(key);
                ctx.body = { ok: true, role: 'owner', memberPubkey: key, callsign: member?.callsign ?? null, again: true };
                return;
            }
            return refuse(ctx, 409, 'claim_already_claimed', 'This community already has an owner.');
        }

        const pending = pendingClaim(config);
        if (!pending) return refuse(ctx, 409, 'claim_no_code', 'This community has no claim code. Restart the server to make one.');
        if (pending.id !== codeId) return refuse(ctx, 409, 'claim_code_changed', 'That claim code is no longer this community\'s. Read the code on the server again.');

        const signed = verify();
        if (!signed.ok) return refuse(ctx, signed.status, signed.code || 'claim_bad_signature', signed.error);

        if (!isClaimCodeShape(body.code)) return refuse(ctx, 400, 'claim_bad_code', 'That is not a claim code. It looks like claim-xxxx-xxxx-xxxx-xxxx.');
        const wait = admitClaimCheck(source);
        if (wait > 0) {
            ctx.set('Retry-After', String(wait));
            return refuse(ctx, 429, 'claim_braked', `Too many tries. Wait ${wait} s and try again.`);
        }
        if (!await claimCodeMatches(body.code, pending.hash)) {
            logger.security('AUTH', `A wrong claim code was refused (key ${key.slice(0, 12)}…, from ${logAddressTag(source)})`);
            return refuse(ctx, 403, 'claim_wrong_code', 'That claim code is not right. Read it on the server again.');
        }

        const callsign = String(body.callsign ?? '').trim().slice(0, 20);
        const outcome = claimNode({ broadcast: deps.broadcast ?? (() => {}), pubkey: key, callsign, claim: pending, source: logAddressTag(source) });
        if (!outcome.ok) return refuse(ctx, outcome.status, outcome.code, outcome.error);
        ctx.body = { ok: true, role: 'owner', memberPubkey: outcome.memberPubkey, callsign: outcome.callsign, again: false };
    });

    return router;
}
