/**
 * Claiming a community that has no owner yet (claim-code.ts). Two routes, both public:
 *
 *   GET  /api/local/claim  whether the node is unclaimed, and if so the waiting code's public id and its salt (both
 *                          public: they make K, not hide it) and the community's name. No scrypt parameters: see below.
 *   POST /api/local/claim  { publicKey, callsign, codeId, signedFor, proof, signature }, claim v2: `proof` is
 *                          HMAC(K, beanpool-claim-proof/1, signedFor, codeId, publicKey), K derived from the code and
 *                          the salt (@beanpool/core claimKeyFromCode, claimProof); `signature` is the key's over
 *                          0xFF ‖ `beanpool-claim/2\n<signedFor>\n<codeId>\n<publicKey>\n<proof>` (claimText). The code
 *                          itself is never sent. There is no v1: no client ever sent one.
 *
 * What binds a claim to this node: the code id (a fresh one per code), and the host. On a node that knows its names the
 * host must be one of them (engine/member-signature.ts audienceRefusal). On a node that knows none, audienceRefusal lets
 * any host through until the switch, and every node takes a home-network host (10.x, 192.168.x, .local): a claim for
 * such a host must also name the host this request was sent to (its Host header), so a signature made for another
 * server is refused here.
 *
 * The proof is checked before any brake, and a right one is never braked (claim-code.ts claimBrakeWait): a wrong proof
 * brakes only its own source for 10 s, and only to shed load. Proof and signature are both bound to the host, the code
 * id and the key, so a claim a phishing server relays is still the phone's key's claim, and one it re-labels for this
 * node's host fails the signature. The answer carries no secret, since a relaying server reads it: the owner gets a
 * break-glass code from Manage or `beanpool recover`. Once the node has an owner every claim is refused, except the
 * same key retrying the claim that made it owner (a lost answer; K is gone, so only the signature is checked): that is
 * answered as the claim was, and changes nothing.
 *
 * Under /api/local/, so the signed-request middleware never sees these (https-server.ts isSignatureBypassed): the
 * statement's own signature is the proof.
 */
import Router from '@koa/router';
import { claimText } from '@beanpool/core';
import type { RouteDeps } from './types.js';
import { clientLimiterKey } from '../client-ip.js';
import { logAddressTag } from '../log-address.js';
import { getLocalConfig, hasAdminPassword } from '../config/local-config.js';
import { nodeHasOwner } from '../engine/node-roles.js';
import { verifyStatementSignature } from '../engine/member-signature.js';
import { audienceStanding, isLocalNetworkHost, normalizeAddress } from '../engine/own-addresses.js';
import {
    brakeClaimSource, claimBrakeWait, claimedByThisKey, claimKey, claimLogAdmit, claimNode, claimProofMatches, isClaimCodeId, pendingClaim,
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
        // No scrypt parameters in this answer. The phone derives K with @beanpool/core's CLAIM_SCRYPT, hard-coded, and
        // must never take N, r or p from here: a phishing server writes this answer itself, and a lower N would make a
        // proof it captured cheap to brute-force offline.
        ctx.body = {
            unclaimed: true,
            codeId: pending ? pending.id : null,
            salt: pending ? pending.salt : null,
            communityName: config.communityName || config.callsign || null,
            // Whether this server has an admin password at all: a new install has none (config/local-config.ts
            // initAdminPassword), and the Settings sign-in then shows no password fold.
            password: hasAdminPassword(config),
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
                boundText: (host) => claimText(host, codeId, key, String(body.proof ?? '')),
                signedFor: body.signedFor,
                oldTexts: [],
            });
            if (!signed.ok) return signed;
            // A node that knows none of its names takes any host above (audienceRefusal), and every node takes any
            // home-network host. The claim must then also name the host this request came to, so a statement signed for
            // another server is no claim here.
            const named = String(body.signedFor);
            if ((audienceStanding(named) === 'unconfigured' || isLocalNetworkHost(named)) && named !== normalizeAddress(ctx.request.host)) {
                return { ok: false as const, status: 421, error: 'This claim was signed for another server.', code: 'wrong_community' };
            }
            return signed;
        };

        const config = getLocalConfig();
        if (nodeHasOwner()) {
            // 409 before any signature check, except for the key the claim made owner with the burned code id (a lost
            // answer). That one check is braked like a wrong proof when it fails, so it costs a source one verify in 10 s.
            if (config.claim?.id === codeId && claimedByThisKey(key, config)) {
                const wait = claimBrakeWait(source);
                if (wait > 0) {
                    ctx.set('Retry-After', String(wait));
                    return refuse(ctx, 429, 'claim_braked', `Too many wrong tries. Wait ${wait} s and try again.`);
                }
                if (verify().ok) {
                    const member = getMember(key);
                    ctx.body = { ok: true, role: 'owner', memberPubkey: key, callsign: member?.callsign ?? null, again: true };
                    return;
                }
                brakeClaimSource(source);
            }
            return refuse(ctx, 409, 'claim_already_claimed', 'This community already has an owner.');
        }

        const pending = pendingClaim(config);
        if (!pending) return refuse(ctx, 409, 'claim_no_code', 'This community has no claim code. Restart the server to make one.');
        if (pending.id !== codeId) return refuse(ctx, 409, 'claim_code_changed', 'That claim code is no longer this community\'s. Read the code on the server again.');

        // The proof first: one HMAC, and a right one never meets the brake.
        const proofRight = claimProofMatches(pending, String(body.signedFor ?? ''), codeId, key, body.proof);
        if (!proofRight) {
            const wait = claimBrakeWait(source);
            if (wait > 0) {
                ctx.set('Retry-After', String(wait));
                return refuse(ctx, 429, 'claim_braked', `Too many wrong tries. Wait ${wait} s and try again.`);
            }
            // Signed or not, a wrong proof brakes its source before the signature check: one verify a source in 10 s.
            brakeClaimSource(source);
        }
        const signed = verify();
        if (!signed.ok) return refuse(ctx, signed.status, signed.code || 'claim_bad_signature', signed.error);
        if (!proofRight) {
            if (claimLogAdmit()) logger.security('AUTH', `A wrong claim proof was refused (key ${key.slice(0, 12)}…, from ${logAddressTag(source)})`);
            return refuse(ctx, 403, 'claim_wrong_code', 'That claim code is not right. Read it on the server again.');
        }

        const callsign = String(body.callsign ?? '').trim().slice(0, 20);
        const outcome = claimNode({ broadcast: deps.broadcast ?? (() => {}), pubkey: key, callsign, claim: pending, source: logAddressTag(source) });
        if (!outcome.ok) return refuse(ctx, outcome.status, outcome.code, outcome.error);
        ctx.body = { ok: true, role: 'owner', memberPubkey: outcome.memberPubkey, callsign: outcome.callsign, again: false };
    });

    return router;
}
