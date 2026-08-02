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

import type { Libp2p } from 'libp2p';
import { db } from './db/db.js';
import { reachAdmitsPeer, parseReachPeers, isSyntheticAccount } from '@beanpool/core';
import { getConnectors, peerIdFromAddress, getConnectorCreditCap, ENABLE_PEER_CONNECTORS } from './connector-manager.js';
import { getMember, registerVisitor } from './state-engine.js';
import { logger } from './logger.js';

/**
 * Prefix on a cached listing's local id. Namespaced by peer so two peers cannot collide on a UUID, and so a
 * remote listing can never be mistaken for — or overwrite — a local one.
 */
export const REMOTE_ID_PREFIX = 'xn:';

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
 * Cache one peer's listings locally, replacing whatever we held for that peer (#143 step 4).
 *
 * REPLACE, NOT MERGE. A listing withdrawn at home, or whose reach was narrowed, simply stops appearing in the
 * peer's answer — there is no "deleted" message and adding one would be a whole retraction protocol. So the
 * peer's current answer IS the truth about that peer, and anything we hold for them that is not in it is
 * gone. Scoped by `origin_node`, so a failed pull for one peer cannot disturb another's cache or, more
 * importantly, any local listing.
 *
 * THE VISITOR HAZARD, which is the sharp edge in this function. Caching a listing needs a member row for its
 * author, because `posts.author_pubkey` references `members` — so this path calls `registerVisitor`. But
 * `registerVisitor` stamps `home_node_url` onto an EXISTING row that has none, which would convert one of our
 * own members into a visitor, and `assertLocalSettlement` (#102) then refuses that member's own local
 * spending. A peer that knows a local member's public key could therefore freeze their account by claiming
 * them as the author of a listing. Exactly the A2-28 impersonation shape, arriving through a new door.
 *
 * So a listing whose author is a LOCAL member is dropped, not cached. Same rule the relay and the settlement
 * exchange already apply, and the reason each is stated where it is enforced rather than trusted to a caller.
 *
 * Returns how many were cached and how many were dropped, so a suspicious answer is visible in the log rather
 * than only in what a member does not see.
 */
export function cacheRemoteListings(
    peerId: string,
    originNode: string,
    listings: unknown,
): { cached: number; dropped: number } {
    if (!peerId || !originNode) return { cached: 0, dropped: 0 };
    const incoming = Array.isArray(listings) ? listings : [];
    let cached = 0, dropped = 0;

    db.transaction(() => {
        // Everything we currently hold FOR THIS PEER. Deleted below unless the answer re-states it, so a
        // withdrawn listing disappears without a retraction message.
        db.prepare('DELETE FROM posts WHERE origin_node = ?').run(originNode);

        for (const raw of incoming) {
            const l = raw as any;
            if (!l || typeof l.id !== 'string' || !l.id
                || typeof l.title !== 'string' || !l.title
                || typeof l.authorPublicKey !== 'string' || !l.authorPublicKey
                || (l.type !== 'offer' && l.type !== 'need')
                // NEGATIVE is refused, ZERO is kept (review finding, accepted as `< 0` not `<= 0`). The
                // compose form's own rule is `Number(credits) < 0` → invalid, so a local member may post at
                // zero — a gift, or "ask me" — and refusing that from a peer would hold their members to a
                // stricter rule than ours. A negative price is nonsense in either community.
                || !Number.isFinite(Number(l.credits)) || Number(l.credits) < 0) {
                dropped++;
                continue;
            }

            // A synthetic account cannot author anything, and a `bridge_`/`escrow_` id arriving as an author
            // would have registerVisitor trying to create a member row for a ledger account.
            if (isSyntheticAccount(l.authorPublicKey)) { dropped++; continue; }

            // THE GUARD. See the note above — this is an account-freeze vector, not a tidiness check.
            const existing = getMember(l.authorPublicKey);
            if (existing && !existing.homeNodeUrl) {
                logger.warn('P2P', `[Listings] Peer ${peerId.slice(-8)} claimed local member ${l.authorPublicKey.slice(0, 8)} as a listing author — dropped`);
                dropped++;
                continue;
            }

            // PER-ROW, so one unusable listing costs one listing and not the peer's whole board. The round is
            // a single transaction for the replace-not-merge semantics; a constraint violation in SQLite rolls
            // back the failing STATEMENT, not the transaction, so carrying on here is safe.
            try {
                registerVisitor(l.authorPublicKey, safeVisitorCallsign(l.authorCallsign, l.authorPublicKey), originNode);

                // The remote id is namespaced so two peers cannot collide on it, and so a remote listing can
                // never overwrite a local one that happens to share a UUID.
                const localId = `${REMOTE_ID_PREFIX}${peerId.slice(-12)}:${l.id}`;
                db.prepare(`INSERT INTO posts (
                    id, type, category, title, description, credits, price_type, author_pubkey, created_at,
                    active, status, repeatable, updated_at, search_keywords, origin_node, reach
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', 0, ?, '', ?, 'local')`).run(
                    localId,
                    l.type,
                    typeof l.category === 'string' && l.category ? l.category : 'other',
                    l.title,
                    typeof l.description === 'string' ? l.description : '',
                    Number(l.credits),
                    typeof l.priceType === 'string' ? l.priceType : 'fixed',
                    l.authorPublicKey,
                    typeof l.createdAt === 'string' ? l.createdAt : new Date(0).toISOString(),
                    typeof l.updatedAt === 'string' ? l.updatedAt : null,
                    originNode,
                );
                cached++;
            } catch (e: any) {
                logger.warn('P2P', `[Listings] Dropped a listing from ${peerId.slice(-8)}: ${e?.message || e}`);
                dropped++;
            }
        }
    })();

    return { cached, dropped };
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
    // DEDUPED BY PEER ID (review finding). Two connectors can carry the same peer id — an operator who
    // added a peer by hostname and again by container IP, or kept an old address while migrating a host.
    // The list is rendered with `key={peerId}`, so a duplicate is a React key collision AND the same
    // community offered twice in the compose form. First entry wins, which keeps whichever callsign the
    // connector list shows first.
    const seen = new Set<string>();
    for (const connector of getConnectors()) {
        if (connector.trustLevel !== 'peer') continue;
        if (getConnectorCreditCap(connector.address) === null) continue;
        const peerId = peerIdFromAddress(connector.address);
        if (!peerId || seen.has(peerId)) continue;
        seen.add(peerId);
        out.push({ peerId, callsign: connector.callsign ?? null });
    }
    return out;
}

/**
 * A remote author's callsign, but only if this node can actually store it.
 *
 * CALLSIGNS ARE UNIQUE PER NODE (#83, a unique index on `lower(callsign)`), and a remote author's name was
 * only ever unique on THEIR node. Two things collide in practice: a member of ours already called "Sam", and
 * two authors on two different peers who are each "Sam" at home. Passing the name through blindly threw
 * `UNIQUE constraint failed: idx_members_callsign_unique` — and since the round is one transaction, a single
 * unlucky name meant a peer's whole board never cached. Found by the test, not in production, which is the
 * only reason it is a footnote instead of an incident.
 *
 * Returning undefined makes `registerVisitor` generate `Visitor-<first 8 of the key>`, which is unique by
 * construction. A worse name is a much better outcome than a missing board — and the callsign shown here was
 * never authoritative anyway: it is a string a peer sent us.
 */
function safeVisitorCallsign(raw: unknown, publicKey: string): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const callsign = raw.trim();
    if (!callsign) return undefined;
    const holder = db.prepare(
        `SELECT public_key FROM members WHERE lower(callsign) = lower(?) AND status NOT IN ('migrated', 'pruned')`
    ).get(callsign) as any;
    // Free, or already this same author's — anyone else's and we fall back.
    return !holder || holder.public_key === publicKey ? callsign : undefined;
}

/**
 * How often to ask each peer for its board.
 *
 * Five minutes is the accepted staleness §7 signed up for: "a listing can be up to one interval stale, so a
 * filled need may briefly still show". Long enough to be nothing on a 1 CPU / 1 GB node or a solar one, short
 * enough that a board is not visibly wrong.
 */
export const LISTING_PULL_INTERVAL_MS = 5 * 60_000;

/** First pull after boot. Late enough that connectors have had their auto-connect window (5s) to dial. */
const FIRST_PULL_DELAY_MS = 30_000;

/**
 * Pull every capped peer's listings once and cache them. Returns a per-peer summary.
 *
 * SEQUENTIAL, not parallel. A node may have several peers and this runs on a 1 CPU box; a round of concurrent
 * dials competing with a settlement in flight is a worse trade than taking a few extra seconds over a job
 * whose whole premise is that it can be stale.
 *
 * One peer failing is not an error — it is a peer that is asleep, which is the case §7 chose pull-and-cache
 * for. Its cache is deliberately LEFT ALONE: clearing it on a failed pull would empty the board every time a
 * solar node napped, which is the exact failure the design rejected.
 */
export async function pullAllPeerListings(node: Libp2p): Promise<Array<{
    peerId: string; callsign: string | null; ok: boolean; cached?: number; dropped?: number; error?: string;
}>> {
    const results: Array<{ peerId: string; callsign: string | null; ok: boolean; cached?: number; dropped?: number; error?: string }> = [];
    if (!ENABLE_PEER_CONNECTORS || !node) return results;

    const { federatedListListings } = await import('./federation-protocol.js');
    const { peerIdFromString } = await import('@libp2p/peer-id');

    for (const { peerId, callsign } of reachablePeers()) {
        // `origin_node` is the peer's public URL, because that is what a client hands back to the purchase
        // route as `nodeUrl` — the same value #148 fixed. Without one there is nothing to record a listing
        // against and no way for a buyer to name the community, so skip rather than cache something unusable.
        const originNode = originNodeFor(peerId);
        if (!originNode) {
            results.push({ peerId, callsign, ok: false, error: 'peer has no public URL to record listings against' });
            continue;
        }
        try {
            const response = await federatedListListings(node, peerIdFromString(peerId));
            if (response?.error) throw new Error(String(response.error));
            const { cached, dropped } = cacheRemoteListings(peerId, originNode, response?.listings);
            results.push({ peerId, callsign, ok: true, cached, dropped });
            logger.info('P2P', `[Listings] ← ${callsign ?? peerId.slice(-8)}: cached ${cached}${dropped ? `, dropped ${dropped}` : ''}`);
        } catch (e: any) {
            // Logged at INFO, not ERROR: an unreachable peer is the ordinary case this design expects, and an
            // error line every five minutes for a sleeping solar node would train an operator to ignore logs.
            results.push({ peerId, callsign, ok: false, error: e?.message || String(e) });
            logger.info('P2P', `[Listings] ← ${callsign ?? peerId.slice(-8)}: no answer (${e?.message || e}) — keeping what we cached`);
        }
    }
    return results;
}

/** The public URL recorded on a peer's cached listings, or null when the peer has not got one. */
function originNodeFor(peerId: string): string | null {
    for (const connector of getConnectors()) {
        if (peerIdFromAddress(connector.address) !== peerId) continue;
        if (connector.publicUrl) return connector.publicUrl;
    }
    return null;
}

let pullTimer: ReturnType<typeof setInterval> | null = null;
// The FIRST pull's handle, tracked separately (review finding). Without it, a shutdown inside the 30-second
// startup window left the timeout armed, and it fired against a closed libp2p node — an error at exactly the
// moment nobody is reading logs, on a path whose whole point is that failure is survivable.
let initialPullTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the pull loop. Idempotent, and a no-op when peer connectors are off.
 *
 * Every tick is wrapped: an unhandled rejection in a background timer takes the node down, and a board being
 * one interval stale is not worth that.
 */
export function startListingPull(node: Libp2p): void {
    if (!ENABLE_PEER_CONNECTORS || !node || pullTimer || initialPullTimer) return;
    const tick = () => { pullAllPeerListings(node).catch(e => logger.warn('P2P', `[Listings] Pull round failed: ${e?.message || e}`)); };
    // .unref() on both, matching the settlement recovery timers above: a discovery refresh must never be the
    // reason a process refuses to exit.
    initialPullTimer = setTimeout(() => { initialPullTimer = null; tick(); }, FIRST_PULL_DELAY_MS);
    initialPullTimer.unref?.();
    pullTimer = setInterval(tick, LISTING_PULL_INTERVAL_MS);
    pullTimer.unref?.();
    logger.info('P2P', `[Listings] Pull loop started — every ${LISTING_PULL_INTERVAL_MS / 60_000} min`);
}

/** Stop the loop. For tests, and so a shutdown does not leave a timer dialling a closed node. */
export function stopListingPull(): void {
    if (initialPullTimer) { clearTimeout(initialPullTimer); initialPullTimer = null; }
    if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
}
