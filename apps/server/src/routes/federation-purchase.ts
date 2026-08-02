/**
 * Cross-node purchase — the buyer's entry point (#143, slice step 1).
 *
 * WHAT THIS CLOSES. Every piece of the buyer's half existed and was tested — `beginOutboundSettlement`,
 * `commitOutboundSettlement`, the compensating reversals, boot recovery, `runOutboundSettlement` composing
 * them, `settleCrossNodePurchase` supplying the transport — and **nothing could call any of it**. No member
 * could trigger a cross-node purchase, so the model was unreachable rather than unfinished.
 *
 * WHAT IT DOES NOT DO YET. It takes the peer and the seller explicitly, because remote listings do not
 * arrive until slice step 4. Once they do, a client will have the peer's node URL from `posts.origin_node`
 * and this route is what the "buy" button ends up calling — the shape does not change, only who supplies the
 * arguments.
 *
 * THE ORDER OF THE CHECKS MATTERS, and it is: cheapest and most certain first, and never touch the ledger
 * until every one of them has passed. `beginOutboundSettlement` debits the buyer into escrow as its very
 * first act, so anything we can refuse beforehand is a refusal that costs the member nothing and needs no
 * compensating entry. See the numbered comments below — each one is a specific thing that must not be
 * possible, not a generic validation sweep.
 *
 * Spec: docs/federation-connector.md §3 (the loop), docs/federation-economics.md §2.5 (the exchange).
 */

import Router from '@koa/router';
import crypto from 'node:crypto';
import { getMember, getNodeConfig } from '../state-engine.js';
import {
    getConnectorByAddress, getConnectorByPublicUrl, peerIdFromAddress, ENABLE_PEER_CONNECTORS,
} from '../connector-manager.js';
import { getP2PNode, getPrivateKey } from '../p2p.js';
import { settleCrossNodePurchase } from '../federation-protocol.js';
import {
    FEDERATION_SETTLEMENT_ENABLED, SETTLEMENT_REFUSED_CODE, SETTLEMENT_REFUSED_MESSAGE, isVisitor,
} from '../federation-settlement.js';
import { SettlementError } from '../federation-settlement-exchange.js';
import type { RouteDeps } from './types.js';

/**
 * This node's own public address, or null if it has never claimed one.
 *
 * Set by the public-address registrar when an operator claims `<name>.beanpool.org` (or brings their own
 * domain), so it is the only place a node knows what it is called from the outside.
 */
function ourPublicUrl(): string | null {
    try {
        const hostname = ((getNodeConfig() as any)?.publicAddress?.hostname ?? '').trim();
        return hostname ? `https://${hostname}` : null;
    } catch {
        return null;   // never let a config read stop a purchase — the peer can derive it
    }
}

/** Reserved account prefixes. A cross-node purchase must never be aimed at one of these. */
const SYNTHETIC_PREFIXES = ['escrow_', 'project_', 'bridge_', 'treasury_'];
const isSyntheticKey = (k: string): boolean =>
    k === 'COMMONS_POOL' || k === 'SYSTEM' || SYNTHETIC_PREFIXES.some(p => k.startsWith(p));

/**
 * HTTP status from a settlement outcome. Every one of these is a *successful* request — the question is
 * what happened to the beans, which the client has to show the member either way.
 *
 *   settled  → 200. Done.
 *   pending  → 202. Accepted, still completing; recovery will finish it or refund.
 *   refused
 *   reversed → 409. The purchase did not happen and the member has their beans back.
 */
const statusFor = (outcome: string): number =>
    outcome === 'settled' ? 200 : outcome === 'pending' ? 202 : 409;

export function createFederationPurchaseRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.post('/api/federation/purchase', async (ctx) => {
        const body = (ctx as any).requestBody || {};
        const { nodeUrl, peerAddress, sellerPublicKey, postId } = body;
        const amount = Number(body.amount);

        // 1. THE KILL SWITCH, before anything else. Off by default on every node, and turning it off must
        //    refuse new trades without a hint that some other input might get past it.
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

        // 2. THE ACTOR IS THE BUYER, with no body fallback. Other marketplace routes accept
        //    `ctx.state.actor || body.buyerPublicKey` because the actor is the buyer there by construction.
        //    Here the buyer is being DEBITED, so a fallback would let a valid signature from any keypair spend
        //    somebody else's beans. The signature middleware guarantees `state.actor` on POST /api/*; this
        //    refuses rather than trusting that, because the cost of being wrong is someone else's balance.
        const buyerPublicKey = ctx.state.actor as string | undefined;
        if (!buyerPublicKey) {
            ctx.status = 401;
            ctx.body = { error: 'A signed request is required to make a purchase' };
            return;
        }
        if (body.buyerPublicKey && body.buyerPublicKey !== buyerPublicKey) {
            ctx.status = 403;
            ctx.body = { error: 'You can only spend your own beans' };
            return;
        }

        // 3. THE BUYER MUST BE ONE OF OURS. Rule 1 is "charge home" — only a member's home node may debit
        //    them. A visitor here holds their beans on another node's ledger, so this node charging them
        //    would be the #102 bug in a new place: reading a ledger it does not write to.
        const buyer = getMember(buyerPublicKey);
        if (!buyer) {
            ctx.status = 403;
            ctx.body = { error: 'Only a member of this community can make a cross-community purchase' };
            return;
        }
        if (isVisitor(buyerPublicKey)) {
            ctx.status = 503;
            ctx.body = {
                error: "You're visiting this community, so your beans live on your home community's ledger — "
                    + 'a purchase has to be made from there. Nothing has been deducted.',
                code: SETTLEMENT_REFUSED_CODE,
            };
            return;
        }

        // 4. Shape of the trade.
        if (!sellerPublicKey || typeof sellerPublicKey !== 'string') {
            ctx.status = 400;
            ctx.body = { error: 'sellerPublicKey is required' };
            return;
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            ctx.status = 400;
            ctx.body = { error: 'amount must be a positive number' };
            return;
        }
        // A synthetic account is not a person and cannot sell. Escrow, bridge and treasury keys are reachable
        // by name, so without this a purchase could be aimed at a peer's bridge row — paying into the very
        // account that records what the two nodes owe each other.
        if (isSyntheticKey(sellerPublicKey)) {
            ctx.status = 400;
            ctx.body = { error: 'That is not a member account' };
            return;
        }
        // A LOCAL seller means this is not a cross-node trade at all, and routing it through settlement would
        // open a bridge tab against a purchase that never left the node — real beans, imaginary obligation.
        // A member row with a home_node_url is a visitor and belongs to the peer, so only a *local* member
        // (no home node) is the mistake being caught here.
        const localSeller = getMember(sellerPublicKey);
        if (localSeller && !isVisitor(sellerPublicKey)) {
            ctx.status = 400;
            ctx.body = { error: 'That seller is in this community — use an ordinary purchase' };
            return;
        }
        if (sellerPublicKey === buyerPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'You cannot buy from yourself' };
            return;
        }

        // 5. THE PEER MUST BE A CONFIGURED TRADING PEER — resolved from the operator's own connector list,
        //    never from the request. The client names a node; which credit line that maps to, and whether we
        //    trade with it at all, is ours to decide. `mirror` is admitted deliberately here and then refused:
        //    a backup replica is not a trading partner, and the difference must be explicit.
        //
        //    THE GATE IS `trustLevel`, NOT `enabled`. These are orthogonal and this route used to conflate
        //    them, refusing every purchase aimed at a Passive peer. `enabled` is a DIALLING setting and
        //    nothing else — it decides who maintains the outbound link (see connector-manager's boot
        //    auto-connect and the disconnect-on-made-passive branch). Exactly one side of a healthy pair is
        //    Active, by the UI's own guidance, so gating trade on it made cross-node trade permanently
        //    one-directional: the Passive community could sell but never buy. That is not a policy, it is an
        //    accident of transport configuration — and it left every bridge tab a ratchet, since a tab only
        //    nets down when trade flows both ways through the same `bridge_<peer>` account.
        //
        //    It was also asymmetric: the INBOUND side (`handlePurchaseRequest`) checks `trusted` and
        //    `trustLevel` and has never looked at `enabled`, so a Passive node already honoured purchases
        //    arriving from its Active peer. Only its own members were refused.
        //
        //    Nothing is lost by dropping it. `blocked` is the control for "stop trading with them", it is in
        //    the Settings dropdown, and it is checked right here. And a Passive node can still reach its peer:
        //    `dialProtocol` is keyed on the peer id and reuses the connection the Active side established.
        const connector = typeof nodeUrl === 'string' && nodeUrl
            ? getConnectorByPublicUrl(nodeUrl)
            : typeof peerAddress === 'string' && peerAddress
                ? getConnectorByAddress(peerAddress)
                : null;
        if (!connector) {
            ctx.status = 404;
            ctx.body = { error: 'That community is not one of this node\'s connectors' };
            return;
        }
        if (connector.trustLevel !== 'peer') {
            ctx.status = 403;
            ctx.body = {
                // NAME THE PEER when we know it. "does not trade with that one" is vague to the one person who
                // reads it — a member who named a community and got a refusal (review finding, accepted). The
                // callsign is the operator's own label for that connector and is what the Settings card shows,
                // so it is the name the member has a chance of recognising. `callsign` is optional on a
                // connector, hence the fallback.
                //
                // Deliberately NOT "Trust Level is not set to peer" (the suggested wording, declined): trust
                // level is operator vocabulary for an operator's screen. A member cannot act on it, and
                // `blocked` is a decision their community made on purpose, not a misconfiguration to report.
                error: connector.trustLevel === 'mirror'
                    ? 'That connection is a backup replica, not a trading partner'
                    : connector.callsign
                        ? `This community does not trade with ${connector.callsign}`
                        : 'This community does not trade with that one',
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

        const node = getP2PNode();
        const privateKey = getPrivateKey();
        if (!node || !privateKey) {
            ctx.status = 503;
            ctx.body = { error: 'This node\'s peer-to-peer transport is not running' };
            return;
        }

        // 6. THE KEY. Minted by the buyer's node (§2.5). A client may supply one to RETRY: the whole outbound
        //    path is idempotent on it, and `runOutboundSettlement` resumes from the row's state — so a retry
        //    after a dropped connection finishes the original purchase instead of starting a second one. Minting
        //    a fresh key on every attempt is what would double-charge.
        const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : `xn-${crypto.randomUUID()}`;

        try {
            const { peerIdFromString } = await import('@libp2p/peer-id');
            const outcome = await settleCrossNodePurchase(node, peerIdFromString(peerId), node.peerId.toString(), privateKey, {
                key,
                peerId,
                buyerPublicKey,
                buyerCallsign: buyer.callsign,
                // OUR public address, if this node has claimed one — the peer records it so its own members can
                // see which community a visiting buyer belongs to.
                //
                // Sent as a courtesy, not as the source of truth. `handlePurchaseRequest` prefers to derive our
                // URL from its own connector record for us, because that comes from the authenticated
                // connection whereas this is just a string we sent. Null when no address has been claimed, and
                // that is fine: the peer's fallback covers it, and only if BOTH are absent does the purchase
                // refuse with `unknown_home_node`.
                buyerHomeNode: ourPublicUrl(),
                sellerPublicKey,
                postId: typeof postId === 'string' ? postId : null,
                amount,
            });
            ctx.status = statusFor(outcome.status);
            ctx.body = { ...outcome, amount, peer: connector.callsign ?? connector.address };
        } catch (e: any) {
            // A throw here means step 1 refused — the local escrow. Nothing has moved, and the reason is the
            // member's to see ("not enough credit to cover this purchase and its fee"). Everything after step 1
            // returns an outcome rather than throwing, precisely so that beans-in-flight are never reported as
            // an error.
            if (e instanceof SettlementError) {
                ctx.status = 400;
                ctx.body = { error: e.message, reason: e.reason, key };
                return;
            }
            console.error(`[Federation] Cross-node purchase ${key} failed:`, e?.message || e);
            ctx.status = 500;
            ctx.body = { error: 'That purchase could not be started. Nothing has been deducted.', key };
        }
    });

    return router;
}
