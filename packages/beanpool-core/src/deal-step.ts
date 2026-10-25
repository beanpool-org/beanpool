/**
 * One rule for a deal that needs you, in core (DESIGN-deals-fable §1.2, §4).
 * Pure and universal: imported by both apps and the server.
 */

import { t } from './words.js';

export type DealRole = 'payer' | 'payee';

export type DealState =
    | 'to-answer'        // requested, I am the listing's author
    | 'asked'            // requested, I asked
    | 'to-release'       // pending, I am the payer
    | 'to-deliver'       // pending, I am the payee
    | 'done-to-review'   // completed, I have not reviewed
    | 'done'
    | 'cancelled'
    | 'declined';

export interface DealStep {
    role: DealRole;
    state: DealState;
    needsMe: boolean;
    pressing: boolean;
    dueSince: string | null;
}

export interface DealRow {
    id?: string;
    postId?: string;
    postTitle?: string | null;
    status: string;
    buyerPublicKey: string;
    buyerCallsign?: string | null;
    sellerPublicKey: string;
    sellerCallsign?: string | null;
    createdAt?: string | null;
    completedAt?: string | null;
    ratedByBuyer?: boolean;
    ratedBySeller?: boolean;
    postAuthorPublicKey?: string | null;
    postRepeatable?: boolean;
    postLendable?: boolean;
    postType?: string | null;
}

const SEVEN_DAYS_MS = 7 * 86_400_000;

/**
 * Computes whose step a deal is in, whether it needs `me`, whether it is pressing,
 * and since when it has been due.
 */
export function dealStep(tx: DealRow, me: string, now: number = Date.now()): DealStep {
    const isPayer = tx.buyerPublicKey === me;
    const role: DealRole = isPayer ? 'payer' : 'payee';

    // Who answers a request: the listing's author.
    // If postAuthorPublicKey is known, compare directly with me.
    // Otherwise fallback based on listing kind: Need's author is buyer, Offer's author is seller.
    const isAuthor = tx.postAuthorPublicKey != null
        ? tx.postAuthorPublicKey === me
        : (tx.postType === 'need' ? isPayer : !isPayer);

    let state: DealState;

    if (tx.status === 'requested') {
        state = isAuthor ? 'to-answer' : 'asked';
    } else if (tx.status === 'pending') {
        state = isPayer ? 'to-release' : 'to-deliver';
    } else if (tx.status === 'completed') {
        const hasReviewed = isPayer ? Boolean(tx.ratedByBuyer) : Boolean(tx.ratedBySeller);
        state = hasReviewed ? 'done' : 'done-to-review';
    } else if (tx.status === 'cancelled') {
        state = 'cancelled';
    } else if (tx.status === 'rejected' || tx.status === 'declined') {
        state = 'declined';
    } else {
        state = 'cancelled';
    }

    const needsMe = state === 'to-answer' || state === 'to-release';

    let pressing = false;
    if (state === 'to-answer') {
        pressing = true;
    } else if (state === 'to-release') {
        const createdMs = tx.createdAt ? Date.parse(tx.createdAt) : NaN;
        pressing = !Number.isNaN(createdMs) && (now - createdMs >= SEVEN_DAYS_MS);
    }

    const dueSince = needsMe ? (tx.createdAt ?? null) : null;

    return { role, state, needsMe, pressing, dueSince };
}

/**
 * Filter deals that need a step from `me` (badge, handshake, pill, Needs you).
 */
export function dealsNeedingMe<T extends DealRow = DealRow>(txs: T[], me: string, now: number = Date.now()): T[] {
    return txs.filter(t => dealStep(t, me, now).needsMe);
}

/**
 * Filter open deals (`requested` or `pending`) for `me` (In Progress, Your deals card),
 * sorted newest first.
 */
export function openDeals<T extends DealRow = DealRow>(txs: T[], me?: string): T[] {
    return txs
        .filter(t => (t.status === 'requested' || t.status === 'pending') && (!me || t.buyerPublicKey === me || t.sellerPublicKey === me))
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * One-line state of a deal, translated via t().
 */
export function dealStateWords(step: DealStep, otherName: string | null, until?: string): string {
    switch (step.state) {
        case 'to-answer':
            return t('Waiting on you: answer');
        case 'to-release':
            if (until) {
                return t('You have it until {date}', { date: until });
            }
            return t('Waiting on you: release');
        case 'to-deliver':
            if (otherName) {
                return t('Waiting on {name} to release', { name: otherName });
            }
            return t('Waiting on them to release');
        case 'asked':
            if (otherName) {
                return t('You asked · waiting on {name}', { name: otherName });
            }
            return t('You asked · waiting on them');
        case 'done-to-review':
            return t('Done · leave a review');
        case 'done':
            return t('Done');
        case 'cancelled':
            return t('Cancelled');
        case 'declined':
            return t('Declined');
    }
}
