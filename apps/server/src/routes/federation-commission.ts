/**
 * Commissioning across a boundary — the keeper's entry point (#143, slice step 5).
 *
 * Spec: docs/federation-connector.md §3 (Half B), §8 step 5. The economics live in `federation-commission`;
 * this file is the authorisation and the argument resolution, and it is deliberately thin.
 *
 * THE ONE DIFFERENCE FROM `/api/federation/purchase`, and everything here follows from it: on a purchase the
 * signer IS the payer, and the route refuses any body field that disagrees. On a commission the signer is a
 * KEEPER and the payer is the link's enterprise, which has no keypair and never signs anything. So the
 * actor-equals-payer check that protects the purchase route is unavailable, and something has to take its
 * place: `canOperateTreasury`, the same #106 binding that governs every other enterprise on the node.
 *
 * THE ORDER OF THE CHECKS MATTERS, same rule as the purchase route: cheapest and most certain first, and
 * nothing touches the ledger until every one has passed. `fundCommission` is the first thing that moves
 * value, so it is last.
 */

import Router from '@koa/router';
import crypto from 'node:crypto';
// Top-level, not `await import(...)` inside the handler (review finding, accepted — though not for the reason
// given). ESM caches a module after its first import, so a dynamic import in a handler is a resolved-promise
// await on an already-loaded module, not "per-request module loading overhead". And libp2p is loaded at boot by
// p2p.ts regardless, so nothing is being deferred. Hoisted because a needless await in the middle of the one
// line that spends the community's beans is worth removing on clarity alone.
//
// The purchase route still does it dynamically. Left alone here rather than swept up: it is a different file
// with no coverage in this PR, and a one-line drive-by in the path that debits members is not free.
import { peerIdFromString } from '@libp2p/peer-id';
import { getMember, getNodeConfig, canOperateTreasury } from '../state-engine.js';
import {
    getConnectorByPublicUrl, peerIdFromAddress, ENABLE_PEER_CONNECTORS,
} from '../connector-manager.js';
import { getP2PNode, getPrivateKey } from '../p2p.js';
import { settleCrossNodePurchase } from '../federation-protocol.js';
import {
    FEDERATION_SETTLEMENT_ENABLED, SETTLEMENT_REFUSED_CODE, SETTLEMENT_REFUSED_MESSAGE, isVisitor,
} from '../federation-settlement.js';
import { SettlementError } from '../federation-settlement-exchange.js';
import { getFederationLink } from '../federation-link.js';
import { commissionCapacity, checkCommissionAllowance, fundCommission, originOfCachedPost } from '../federation-commission.js';
import type { RouteDeps } from './types.js';

/** This node's own public address, or null. Same helper as the purchase route, same reasoning. */
function ourPublicUrl(): string | null {
    try {
        const hostname = ((getNodeConfig() as any)?.publicAddress?.hostname ?? '').trim();
        return hostname ? `https://${hostname}` : null;
    } catch {
        return null;
    }
}

const statusFor = (outcome: string): number =>
    outcome === 'settled' ? 200 : outcome === 'pending' ? 202 : 409;

export function createFederationCommissionRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    /**
     * What this member may commission, per link they keep. Drives the button's enabled state and the number
     * beside it, so a keeper is never invited to press something that will refuse.
     *
     * Signed and keeper-scoped: the allowance is a governance-grade fact about the community's economy, but
     * *whose* discretion it is is not public, and a list of links a member does not keep is noise.
     */
    router.get('/api/federation/commission/capacity', async (ctx) => {
        const actor = ctx.state.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'A signed request is required' };
            return;
        }
        const { listFederationLinks } = await import('../federation-link.js');
        const mine = listFederationLinks().filter(l => canOperateTreasury(actor, l.treasuryPubkey));
        ctx.body = {
            links: mine.map(l => commissionCapacity(l.peerId)).filter(Boolean),
        };
    });

    /**
     * Commission a partner community's listing, funded from the Commons pot within the ceiling.
     *
     * Takes `postId` — a cached remote listing on this node's own board — rather than a peer and a seller.
     * That is not a convenience: it is what makes the peer unforgeable. `origin_node` was written by our own
     * pull (#143 step 4) from an authenticated libp2p stream, so resolving the peer from the post means a
     * keeper cannot aim a commission at a community we do not settle with, or at a seller who does not
     * belong to the community being charged.
     */
    router.post('/api/federation/commission', async (ctx) => {
        const body = (ctx as any).requestBody || {};
        const { postId } = body;

        // 1. THE KILL SWITCHES. Off by default on every node.
        if (!FEDERATION_SETTLEMENT_ENABLED) {
            ctx.status = 503;
            ctx.body = { error: SETTLEMENT_REFUSED_MESSAGE, code: SETTLEMENT_REFUSED_CODE };
            return;
        }
        if (!ENABLE_PEER_CONNECTORS) {
            ctx.status = 503;
            ctx.body = { error: 'Peer connectors are not enabled on this node', code: SETTLEMENT_REFUSED_CODE };
            return;
        }

        // 2. THE ACTOR IS THE KEEPER. No body fallback, for the same reason the purchase route refuses one:
        //    what follows spends the community's Commons, so a valid signature from any keypair must not be
        //    able to name someone else as the one authorising it.
        const keeper = ctx.state.actor as string | undefined;
        if (!keeper) {
            ctx.status = 401;
            ctx.body = { error: 'A signed request is required to commission work' };
            return;
        }
        const keeperMember = getMember(keeper);
        if (!keeperMember) {
            ctx.status = 403;
            ctx.body = { error: 'Only a member of this community can commission across a boundary' };
            return;
        }
        // A visitor's beans live elsewhere, but that is not why this refuses — the payer here is the
        // enterprise, not them. It refuses because keeping a community's link is a role in THIS community,
        // and a visitor holds no roles here. Rule 1 in its governance form rather than its ledger form.
        if (isVisitor(keeper)) {
            ctx.status = 403;
            ctx.body = { error: "You're visiting this community, so you can't act for one of its enterprises." };
            return;
        }

        // 3. THE LISTING, and through it the peer. Resolved from our own board — see the route docstring.
        if (!postId || typeof postId !== 'string') {
            ctx.status = 400;
            ctx.body = { error: 'postId is required — commission a listing from your board' };
            return;
        }
        const listing = originOfCachedPost(postId);
        if (!listing) {
            ctx.status = 404;
            ctx.body = {
                error: 'That listing is not a live one from a partner community. A commission is aimed at a '
                    + "listing another community shared with us — one of your own is an ordinary purchase.",
            };
            return;
        }
        const connector = getConnectorByPublicUrl(listing.originNode);
        if (!connector || connector.trustLevel !== 'peer') {
            ctx.status = 403;
            ctx.body = {
                // A cached listing whose peer is now `blocked` or gone. The listing will disappear at the
                // next pull; until then the refusal has to say something true.
                error: 'That listing came from a community this node no longer trades with.',
                code: SETTLEMENT_REFUSED_CODE,
            };
            return;
        }
        const peerId = peerIdFromAddress(connector.address);
        if (!peerId) {
            ctx.status = 400;
            ctx.body = { error: 'That connector has no peer id in its address' };
            return;
        }

        // 4. THE AUTHORISATION. A link is an enterprise (§7), so its keeper is whoever #106 says it is —
        //    `members.can_operate` plus an explicit `treasury_operators` binding, with the admin holding a
        //    node-wide override. Deliberately NOT a new permission: a second answer to "who may act for this
        //    enterprise" is how the two drift apart, and open decision 4 (appointed vs nominated) is still
        //    open — whatever settles it will change `canOperateTreasury`, and this inherits the answer.
        const link = getFederationLink(peerId);
        if (!link) {
            ctx.status = 404;
            ctx.body = {
                error: `${connector.callsign ?? 'That community'} has no link enterprise yet. An operator sets a credit limit for them in Settings, which creates one.`,
            };
            return;
        }
        if (!canOperateTreasury(keeper, link.treasuryPubkey)) {
            ctx.status = 403;
            ctx.body = { error: `You are not a keeper of ${link.name}, so you can't commission on its behalf.` };
            return;
        }

        // 5. THE AMOUNT. Defaults to the listing's own price, which is the normal case — a keeper pressing
        //    "commission" on a card. An explicit amount is accepted for an hourly or negotiated listing, the
        //    same latitude an ordinary purchase has, and is bounded by the allowance either way.
        const amount = body.amount === undefined ? Number(listing.credits) : Number(body.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            ctx.status = 400;
            ctx.body = { error: 'amount must be a positive number' };
            return;
        }

        // 6. THE SELLER MUST BELONG TO THE COMMUNITY BEING CHARGED. `originOfCachedPost` gives us the author
        //    our own pull recorded, and `cacheRemoteListings` already refuses a listing whose author is a
        //    local member. Re-checked here because this is the point of payment: a local seller would open a
        //    bridge tab against a trade that never left the node — real beans, imaginary obligation.
        const seller = listing.authorPublicKey;
        if (!seller || !isVisitor(seller)) {
            ctx.status = 400;
            ctx.body = { error: 'That listing\'s author is not a member of the partner community.' };
            return;
        }
        if (seller === link.treasuryPubkey) {
            ctx.status = 400;
            ctx.body = { error: 'A link cannot commission itself.' };
            return;
        }

        // 7. THE ALLOWANCE, as a pure read, BEFORE the transport check.
        //
        // Both are refusals that cost nothing, so the never-touch-the-ledger-first rule does not order them —
        // but a keeper who is over their allowance is over it whether the network is up or not, and "the
        // transport is not running" is transient where this is deterministic. Reporting the transient one
        // first hides the permanent one behind an error that invites a retry that cannot succeed. (A test
        // asserting the 409 and getting a 503 is what surfaced this.)
        //
        // Not the enforcement point — `fundCommission` re-checks, because that is where beans move and the tab
        // can shift between the two calls.
        const allowance = checkCommissionAllowance(peerId, amount);
        if (!allowance.ok) {
            ctx.status = allowance.reason === 'no_link' ? 404 : 409;
            const { ok: _ok, ...detail } = allowance;
            ctx.body = { ...detail, error: allowance.message };
            return;
        }

        // 8. THE TRANSPORT. Last of the free refusals, and deliberately after the allowance — see above.
        const node = getP2PNode();
        const privateKey = getPrivateKey();
        if (!node || !privateKey) {
            ctx.status = 503;
            ctx.body = { error: 'This node\'s peer-to-peer transport is not running' };
            return;
        }

        // 9. THE KEY, minted here. A client may supply one to retry — the outbound path is idempotent on it,
        //    so a retry after a dropped connection finishes the original commission rather than funding a
        //    second one. `xc-` rather than `xn-` so a commission is identifiable in a settlement row without
        //    joining anything: the two have different funding and different authorisation, and when one of
        //    them is stuck at 3am that distinction is the first thing worth knowing.
        const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : `xc-${crypto.randomUUID()}`;

        // 10. FUND IT. The first ledger movement in the whole flow, hence last. Re-checks the allowance,
        //     spends the enterprise's own balance before the pot, and refuses without moving anything if
        //     either is short.
        const funding = fundCommission(peerId, amount);
        if (!funding.ok) {
            ctx.status = funding.reason === 'no_link' ? 404 : 409;
            // Spread first: the refusal already carries `reason` and its own per-case fields (allowance,
            // shortfall, commonsBalance), and re-stating `reason` after the spread silently overwrites it
            // with the same value while reading as if it were the authority. `ok` is dropped — the HTTP
            // status is the answer to "did it work", and a body field disagreeing with it is a trap.
            const { ok: _ok, ...detail } = funding;
            ctx.body = { ...detail, error: funding.message };
            return;
        }

        try {
            const outcome = await settleCrossNodePurchase(node, peerIdFromString(peerId), node.peerId.toString(), privateKey, {
                key,
                peerId,
                // THE ENTERPRISE IS THE BUYER OF RECORD, and the callsign the peer sees is the link's name.
                // Their member is being paid by a community rather than by a person, and the receipt should
                // say so — "eastgippy Link" is exactly what a Gippsland seller should see when Gippsland's
                // partner commissions their work.
                buyerPublicKey: link.treasuryPubkey,
                buyerCallsign: link.name,
                buyerHomeNode: ourPublicUrl(),
                sellerPublicKey: seller,
                postId,
                amount: funding.amount,
            });
            ctx.status = statusFor(outcome.status);
            ctx.body = {
                ...outcome,
                amount: funding.amount,
                fee: funding.fee,
                drawnFromCommons: funding.drawnFromCommons,
                commissionedBy: link.name,
                peer: connector.callsign ?? connector.address,
                listing: listing.title,
            };
        } catch (e: any) {
            // A throw is step 1 refusing — the local escrow. The enterprise keeps the beans we just funded
            // it with: not lost (conservation holds and the card shows them), and the next commission spends
            // them before touching the pot. Said plainly in the error because a keeper watching the Commons
            // drop by 5 deserves to know where the 5 went.
            const parked = 'The beans stay with the link and will be spent by the next commission.';
            if (e instanceof SettlementError) {
                ctx.status = 400;
                ctx.body = { error: `${e.message} ${parked}`, reason: e.reason, key };
                return;
            }
            console.error(`[Federation] Commission ${key} failed:`, e?.message || e);
            ctx.status = 500;
            ctx.body = { error: `That commission could not be started. ${parked}`, key };
        }
    });

    return router;
}
