/**
 * Cross-node settlement policy.
 *
 * A visitor — a member carrying a `homeNodeUrl` — holds their beans on their home
 * node's ledger, not ours. Moving value on their behalf therefore means debiting that
 * remote ledger: a two-phase commit across nodes this node does not implement yet
 * (#104, spec pending in #103). Until it does, we refuse to move a visitor's value
 * rather than create it locally.
 *
 * WHY THIS IS A REFUSAL AND NOT A BALANCE CHECK (#102):
 * Both call sites previously verified the visitor's home balance over libp2p and then
 * performed a purely LOCAL transfer. The home ledger was read and never written, so
 * the same beans could be spent once on every node the member visited. That check was
 * also skipped outright whenever the p2p node, the connector, or its peerId was
 * missing — falling through to an unchecked local transfer. A correct debit is #104's
 * job; there is no version of it that belongs in a route guard.
 *
 * When #104 lands this module becomes the off-state of the settlement feature flag —
 * it is not scaffolding to delete.
 */

import { getMember } from './state-engine.js';

/** Off until charge-home settlement exists (#104). Typed as boolean so the guard below stays reachable. */
export const FEDERATION_SETTLEMENT_ENABLED: boolean = false;

/** A member whose beans live on another node's ledger. */
export function isVisitor(publicKey: string): boolean {
    return !!getMember(publicKey)?.homeNodeUrl;
}

/**
 * Route guard for any public route that moves a member's value.
 *
 * Returns true — having already written the response — when this node must not move
 * `fromPubkey`'s beans. Call it before the ledger write:
 *
 *     if (blockCrossNodeSettlement(ctx, from)) return;
 */
export function blockCrossNodeSettlement(ctx: any, fromPubkey: string): boolean {
    if (FEDERATION_SETTLEMENT_ENABLED) return false;
    if (!isVisitor(fromPubkey)) return false;

    ctx.status = 503;
    ctx.body = {
        error: "You're visiting this community, so your beans still live on your home community's ledger — spending them from here isn't available yet. Nothing has been deducted.",
        code: 'federation_settlement_disabled',
    };
    return true;
}
