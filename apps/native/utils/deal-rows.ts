/**
 * A deal row as the phone's own database hands it over (getDealsBetween, getActionableDeals), in core's shape, so the
 * chat and Talk ask core's dealStep whose step it is (DESIGN-deals-fable §4) and not a copy of the rule. Pure.
 */

import { dealStep, type DealRow } from '@beanpool/core';

/** The columns both reads select: the deal, the other side, the listing's author and kind, and whether `me` rated it. */
export interface LocalDealRow {
    txId: string;
    postId?: string | null;
    postTitle?: string | null;
    status: string;
    buyerPubkey: string;
    sellerPubkey: string;
    createdAt?: string | null;
    iRated?: boolean | number | null;
    postAuthorPublicKey?: string | null;
    postType?: string | null;
    postRepeatable?: boolean | number | null;
    postLendable?: boolean | number | null;
}

export function localDealRow(r: LocalDealRow, me: string): DealRow {
    const rated = Boolean(r.iRated);
    return {
        id: r.txId,
        postId: r.postId ?? undefined,
        postTitle: r.postTitle ?? null,
        status: r.status,
        buyerPublicKey: r.buyerPubkey,
        sellerPublicKey: r.sellerPubkey,
        createdAt: r.createdAt ?? null,
        // Only the member's own rating is held on this phone's row: the other side's is never asked.
        ratedByBuyer: r.buyerPubkey === me ? rated : false,
        ratedBySeller: r.sellerPubkey === me ? rated : false,
        postAuthorPublicKey: r.postAuthorPublicKey ?? null,
        postType: r.postType ?? null,
        postRepeatable: Boolean(r.postRepeatable),
        postLendable: Boolean(r.postLendable),
    };
}

/**
 * What a deal asks of `me` in Talk's Action Required, by core's dealStep: Beans of mine to release, a request on my listing
 * to answer, a finished trade to review. A deal waiting on the OTHER side (Beans held for me, my own request) asks nothing
 * of me in the app, so it is none. release + answer are exactly core's dealsNeedingMe.
 */
export function dealAction(r: LocalDealRow, me: string): 'release' | 'answer' | 'review' | null {
    const state = dealStep(localDealRow(r, me), me).state;
    if (state === 'to-release') return 'release';
    if (state === 'to-answer') return 'answer';
    if (state === 'done-to-review') return 'review';
    return null;
}

/** A request on the member's own listing that waits for their answer (core's dealStep `to-answer`): nobody else's, and not their own. */
export function isRequestToAnswer(r: LocalDealRow, me: string): boolean {
    return r.status === 'requested' && dealStep(localDealRow(r, me), me).state === 'to-answer';
}
