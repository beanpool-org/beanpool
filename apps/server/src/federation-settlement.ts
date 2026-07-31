/**
 * Cross-node settlement policy.
 *
 * A visitor — a member carrying a `homeNodeUrl` — holds their beans on their home node's ledger.
 * Moving value on their behalf therefore means debiting that remote ledger: a two-phase commit across
 * nodes this node does not implement yet (#104, spec in docs/federation-economics.md). Until it does,
 * we refuse to move a visitor's value rather than create it locally.
 *
 * WHY THIS IS A REFUSAL AND NOT A BALANCE CHECK (#102):
 * The routes previously verified the visitor's home balance over libp2p and then moved value LOCALLY,
 * so the home ledger was read and never written — the same beans could be spent once on every node
 * the member visited. That check was also skipped outright whenever the p2p node, the connector, or
 * its peerId was missing. A correct debit is #104's job; there is no version of it that belongs in a
 * route guard.
 *
 * WHERE THE GUARD LIVES, AND WHY IT IS IN TWO PLACES:
 * `assertLocalSettlement()` sits at the DRAW POINT inside the escrow engine, which is the only place
 * that reliably knows who is paying. On a marketplace Need the payer is the post's author, not the
 * request's actor; on an approval the payer is the buyer recorded on the transaction row, not the
 * approver. A guard that only inspected the authenticated actor would miss both. Putting it where
 * `payerPubkey` is already resolved means every current and future caller is covered.
 * `blockCrossNodeSettlement()` is the route-level form, used where the payer IS the actor, so those
 * routes can answer with a clean 503 instead of a thrown 400.
 *
 * SCOPE: this guards a visitor SPENDING here. A visitor *receiving* beans locally is a different and
 * far less dangerous question — the books still balance, it just strands a positive — and it is left
 * alone deliberately rather than half-solved.
 *
 * Depends only on leaves (`db`, `@beanpool/engine`) and never on state-engine, so the escrow engine
 * can import it without a cycle.
 */

import { getMember } from '@beanpool/engine';
import { db } from './db/db.js';

/** Off until charge-home settlement exists (#104). Typed as boolean so the guards stay reachable. */
export const FEDERATION_SETTLEMENT_ENABLED: boolean = false;

/** The user-facing refusal. Says what is true, and that nothing was taken. */
export const SETTLEMENT_REFUSED_MESSAGE =
    "You're visiting this community, so your beans still live on your home community's ledger — spending them from here isn't available yet. Nothing has been deducted.";

/** Machine-readable discriminator, so clients (and our own route handlers) can branch on it. */
export const SETTLEMENT_REFUSED_CODE = 'federation_settlement_disabled';

/** An Error carrying the settlement code, so a route catch block can map it to a 503. */
export interface SettlementRefusedError extends Error {
    code?: string;
}

/**
 * A member whose beans live on another node's ledger.
 *
 * Tolerates a missing/non-string key: this is called from guards that may run before a route has
 * finished validating its inputs, and "no identity" is not a visitor.
 */
export function isVisitor(publicKey?: string | null): boolean {
    if (!publicKey || typeof publicKey !== 'string') return false;
    return !!getMember(db, publicKey)?.homeNodeUrl;
}

/**
 * Engine-level guard, for the point where value is actually drawn. Throws if `payerPubkey` is a
 * visitor, so the caller's existing error handling surfaces it.
 *
 * Call this immediately before a floor check or an escrow transfer, with the resolved PAYER — not the
 * request's actor.
 */
export function assertLocalSettlement(payerPubkey?: string | null): void {
    if (FEDERATION_SETTLEMENT_ENABLED) return;
    if (!isVisitor(payerPubkey)) return;
    const err: SettlementRefusedError = new Error(SETTLEMENT_REFUSED_MESSAGE);
    err.code = SETTLEMENT_REFUSED_CODE;
    throw err;
}

/**
 * Route-level guard for a public route that moves a member's value.
 *
 * Returns true — having already written the response — when this node must not move the value.
 * Checks the authenticated actor *and* every candidate payer passed in: on signed routes the two
 * agree (the spoof-guard pins body `*pubkey` fields to the signer), but the guard must not depend on
 * that. If any identity involved is a visitor, refuse.
 *
 *     if (blockCrossNodeSettlement(ctx, from)) return;
 */
export function blockCrossNodeSettlement(ctx: any, ...candidatePayers: Array<string | null | undefined>): boolean {
    if (FEDERATION_SETTLEMENT_ENABLED) return false;

    const identities = [ctx?.state?.actor as string | undefined, ...candidatePayers];
    if (!identities.some(isVisitor)) return false;

    ctx.status = 503;
    ctx.body = { error: SETTLEMENT_REFUSED_MESSAGE, code: SETTLEMENT_REFUSED_CODE };
    return true;
}

/**
 * Map a thrown error to a response. Returns 503 + the settlement code for a settlement refusal (which
 * is a capability being off, not the caller's mistake), 400 otherwise.
 *
 * Used by the marketplace routes, where the refusal originates in the engine because only the engine
 * knows who is paying.
 */
export function respondSettlementAware(ctx: any, err: SettlementRefusedError, fallback = 'Request failed'): void {
    if (err?.code === SETTLEMENT_REFUSED_CODE) {
        ctx.status = 503;
        ctx.body = { error: err.message || SETTLEMENT_REFUSED_MESSAGE, code: SETTLEMENT_REFUSED_CODE };
        return;
    }
    ctx.status = 400;
    ctx.body = { error: err?.message || fallback };
}
