/**
 * What a peer may see of this community's marketplace (#143, slice step 4).
 *
 * Spec: docs/federation-connector.md §7 — reach is three-tier (local / named peers / everywhere), and a
 * partner's listings arrive by periodic pull rather than push, because off-grid and solar nodes sleep and a
 * board that empties whenever a peer naps is not a board.
 *
 * This module is the SERVE half: given an authenticated peer id, which of our listings did their authors
 * agree to show that community. The pull that fetches a peer's listings and caches them locally is the other
 * half and lands next.
 *
 * **RULE 9 — A DISCOVERY FILTER, NOT AN ACCESS CONTROL.** What leaves here is a copy, and no later change of
 * reach can retract it. So this is "what did the poster ask us to send", not "what is this peer permitted to
 * know". Nothing downstream should treat a reach check as a security boundary.
 */

import { db } from './db/db.js';
import { reachAdmitsPeer, parseReachPeers } from '@beanpool/core';
import { getConnectors, peerIdFromAddress, getConnectorCreditCap } from './connector-manager.js';

/**
 * One listing as it crosses the wire.
 *
 * Deliberately NARROWER than `MarketplacePost`. A peer needs enough to render a card and start a purchase;
 * it does not need our members' avatars, trust points, escrow state or pending transaction ids. Every field
 * omitted here is a field that cannot leak by accident later, which matters because the receiving node
 * writes what it is sent.
 */
export interface RemoteListing {
    id: string;
    type: 'offer' | 'need';
    category: string;
    title: string;
    description: string;
    credits: number;
    priceType: string;
    /** The seller. Needed to start a cross-node purchase — it is the `sellerPublicKey` of step 1's route. */
    authorPublicKey: string;
    authorCallsign: string;
    createdAt: string;
    updatedAt: string | null;
}

/** How many listings one pull may carry. A bound, so a large community cannot flood a small peer. */
export const LISTINGS_PER_PULL = 200;

/**
 * The listings this node offers to `peerId`, newest first.
 *
 * Three conditions, each load-bearing:
 *
 *   status='active'        a completed or cancelled listing is not on offer to anyone.
 *   origin_node IS NULL    LOOP PREVENTION, and the important one. A listing we pulled FROM a peer must
 *                          never be served onward: two nodes would trade each other's copies back and
 *                          forth, a third would receive listings from a community it has no relationship
 *                          with, and `origin_node` would end up naming the wrong community — which is the
 *                          field the buyer's node charges against. Federation here is bilateral by design.
 *   reachAdmitsPeer(...)   what the author actually asked for.
 *
 * The reach test runs in JS rather than SQL because `reach_peers` is a JSON array and the predicate lives in
 * @beanpool/core, shared with the client. Filtering peers in SQL would mean a second definition of the rule.
 */
export function listingsForPeer(peerId: string, limit = LISTINGS_PER_PULL): RemoteListing[] {
    if (!peerId) return [];

    const rows = db.prepare(`
        SELECT p.id, p.type, p.category, p.title, p.description, p.credits, p.price_type,
               p.author_pubkey, p.created_at, p.updated_at, p.reach, p.reach_peers,
               m.callsign AS author_callsign
        FROM posts p
        JOIN members m ON m.public_key = p.author_pubkey
        WHERE p.status = 'active'
          AND p.active = 1
          AND p.origin_node IS NULL
          AND p.reach != 'local'
        ORDER BY p.created_at DESC
    `).all() as any[];

    const admitted: RemoteListing[] = [];
    for (const row of rows) {
        if (!reachAdmitsPeer(row.reach, parseReachPeers(row.reach_peers), peerId)) continue;
        admitted.push({
            id: row.id,
            type: row.type,
            category: row.category,
            title: row.title,
            description: row.description,
            credits: row.credits,
            priceType: row.price_type ?? 'fixed',
            authorPublicKey: row.author_pubkey,
            authorCallsign: row.author_callsign,
            createdAt: row.created_at,
            updatedAt: row.updated_at ?? null,
        });
        if (admitted.length >= limit) break;
    }
    return admitted;
}

/**
 * Peer ids this node could name in a listing's reach: peers we actually settle with.
 *
 * A cap is the line between "configured" and "we trade with them" everywhere else in federation, so naming a
 * capless peer in a reach would promise a member discovery into a community no purchase could complete from.
 * Powers the multi-select the poster sees.
 */
export function reachablePeers(): Array<{ peerId: string; callsign: string | null }> {
    const out: Array<{ peerId: string; callsign: string | null }> = [];
    for (const connector of getConnectors()) {
        if (connector.trustLevel !== 'peer') continue;
        if (getConnectorCreditCap(connector.address) === null) continue;
        const peerId = peerIdFromAddress(connector.address);
        if (!peerId) continue;
        out.push({ peerId, callsign: connector.callsign ?? null });
    }
    return out;
}
