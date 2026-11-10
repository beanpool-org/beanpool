/**
 * A deal row as the phone's own database hands it over (getDealsBetween, getActionableDeals), in core's shape, so the
 * chat and Talk ask core's dealStep whose step it is (DESIGN-deals-fable §4) and not a copy of the rule. Pure.
 */

import { dealMoves, dealStep, type DealMoves, type DealRow } from '@beanpool/core';
import { standingOfRow } from './standing-row';

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
    /** A standing deal's period: its id, its number and, on its current row, the standing JSON (utils/standing-row.ts). */
    standing_id?: string | null;
    period_no?: number | null;
    standing?: string | null;
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
        // A period of a standing deal: core never offers Release or Cancel on one, and reviews only its first period.
        ...standingOfRow(r),
    };
}

/**
 * The deal buttons a local row may show `me` (the chat's pinned strip and inline bar), by core's one rule, dealMoves: no
 * surface reads `status === 'pending' && iAmBuyer` on its own (DESIGN-standing-deals-upfront-fable §3). Null for a stranger.
 */
export function localDealMoves(r: LocalDealRow, me: string, now: number = Date.now()): DealMoves | null {
    if (!me) return null;
    return dealMoves(localDealRow(r, me), me, [], now);
}

/** A local row as the chat's pinned strip lists it: Beans held that this member can act on or waits on, a request to answer, a trade to review. */
export function isChatStripDeal(r: LocalDealRow, me: string, now: number = Date.now()): boolean {
    const m = localDealMoves(r, me, now);
    if (!m) return false;
    const held = r.status === 'pending' && !r.standing_id;
    return held || m.answer || m.step.state === 'done-to-review';
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
