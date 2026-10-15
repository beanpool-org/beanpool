import { nearestFinishedTrade } from '@beanpool/core';
import type { MarketplaceTransaction } from './api';

// One answer for the Messages list's "Action Needed" line and the chat's rate button: a finished trade, keyed by the
// trade itself, never by its post. A trade chat is one DM per pair (conversations.post_id is NULL since trades moved
// there), so the conversation's post says nothing; and one offer can have several buyers, so the first completed row
// for a post can be somebody else's deal.

/** Has `me` rated this trade? */
export function iRated(tx: MarketplaceTransaction, me: string): boolean {
    if (tx.buyerPublicKey === me) return !!tx.ratedByBuyer;
    if (tx.sellerPublicKey === me) return !!tx.ratedBySeller;
    return true; // not mine to rate
}

function between(tx: MarketplaceTransaction, me: string, peer: string): boolean {
    return (tx.buyerPublicKey === me && tx.sellerPublicKey === peer) || (tx.sellerPublicKey === me && tx.buyerPublicKey === peer);
}

/** The newest completed trade between `me` and `peer` that `me` has not rated, or null. */
export function unratedTradeWith(txs: MarketplaceTransaction[], me: string, peer: string): MarketplaceTransaction | null {
    if (!me || !peer || me === peer) return null;
    let best: MarketplaceTransaction | null = null;
    for (const tx of txs) {
        if (tx.status !== 'completed' || !between(tx, me, peer) || iRated(tx, me)) continue;
        if (!best || (tx.completedAt ?? tx.createdAt) > (best.completedAt ?? best.createdAt)) best = tx;
    }
    return best;
}

/**
 * The trade an ESCROW_RELEASED line is about: the `transactionId` the node writes into it (since #1604), else (an older
 * line) the completed trade on its post between the two people it names that finished nearest the line's own time `at`:
 * the node writes the line as the trade completes, and one pair can buy a repeatable offer twice, so "the first one on
 * the post" would answer for the other deal. Undefined when this member's trades don't hold it.
 */
export function tradeOfReleaseLine(
    txs: MarketplaceTransaction[],
    meta: { transactionId?: unknown; postId?: unknown; buyerPubkey?: unknown; sellerPubkey?: unknown } | null | undefined,
    at?: string,
): MarketplaceTransaction | undefined {
    if (!meta) return undefined;
    if (typeof meta.transactionId === 'string' && meta.transactionId) {
        return txs.find(tx => tx.id === meta.transactionId);
    }
    if (typeof meta.postId !== 'string' || !meta.postId) return undefined;
    const candidates = txs.filter(tx => tx.status === 'completed' && tx.postId === meta.postId
        && (typeof meta.buyerPubkey !== 'string' || tx.buyerPublicKey === meta.buyerPubkey)
        && (typeof meta.sellerPubkey !== 'string' || tx.sellerPublicKey === meta.sellerPubkey));
    // The same rule the phone reads an old line by (core release-line-trade).
    return nearestFinishedTrade(candidates, at, tx => tx.completedAt ?? tx.createdAt);
}

/** What the rating form needs for this trade, from `me`'s side. */
export function reviewTargetOf(tx: MarketplaceTransaction, me: string): { txId: string; targetPubkey: string; targetCallsign: string; targetRole: 'provider' | 'receiver' } {
    const iAmBuyer = tx.buyerPublicKey === me;
    return {
        txId: tx.id,
        targetPubkey: iAmBuyer ? tx.sellerPublicKey : tx.buyerPublicKey,
        targetCallsign: (iAmBuyer ? tx.sellerCallsign : tx.buyerCallsign) || '',
        // The seller provides; the person I rate is the provider when I bought.
        targetRole: iAmBuyer ? 'provider' : 'receiver',
    };
}
