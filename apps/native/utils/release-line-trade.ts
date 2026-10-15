import { nearestFinishedTrade } from '@beanpool/core';

/** A completed trade as the phone's marketplace_transactions table holds it. */
export interface PhoneTradeRow {
    id: string;
    post_id: string;
    buyer_pubkey: string;
    seller_pubkey: string;
    completed_at?: string | null;
    created_at?: string | null;
}

/**
 * The trade an ESCROW_RELEASED line in this chat is about, by id: the `transactionId` the node writes into the line
 * (since #1604), else for an older line the completed trade on its post between its two people that finished nearest the
 * line's own time (core nearestFinishedTrade — the web reads an old line the same way). The two people are the line's
 * buyer and seller when it names them, else me and this chat's peer; with neither known, no answer (never another
 * buyer's trade on the same post). Null when the phone doesn't hold it.
 */
export function releaseLineTradeId(
    myCompletedTrades: readonly PhoneTradeRow[],
    meta: { transactionId?: unknown; postId?: unknown; buyerPubkey?: unknown; sellerPubkey?: unknown } | null | undefined,
    lineAt: string | null | undefined,
    me: string | null | undefined,
    peer: string | null | undefined,
): string | null {
    if (!meta) return null;
    if (typeof meta.transactionId === 'string' && meta.transactionId) return meta.transactionId;
    if (typeof meta.postId !== 'string' || !meta.postId) return null;
    const named = typeof meta.buyerPubkey === 'string' && typeof meta.sellerPubkey === 'string';
    if (!named && !(me && peer)) return null;
    const candidates = myCompletedTrades.filter(t => t.post_id === meta.postId && (named
        ? t.buyer_pubkey === meta.buyerPubkey && t.seller_pubkey === meta.sellerPubkey
        : (t.buyer_pubkey === me && t.seller_pubkey === peer) || (t.buyer_pubkey === peer && t.seller_pubkey === me)));
    return nearestFinishedTrade(candidates, lineAt, t => t.completed_at ?? t.created_at)?.id ?? null;
}
