/**
 * One rule for a deal that needs you, in core (DESIGN-deals-fable §1.2, §4).
 * Pure and universal: imported by both apps and the server.
 */

import { formatNumber, t } from './words.js';
import { amountRefusalWords, isAmbiguousAmount, type ParsedAmount } from './amount-input.js';

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
    const isPayee = tx.sellerPublicKey === me;
    const isParty = isPayer || isPayee;
    const role: DealRole = isPayer ? 'payer' : 'payee';

    // Who answers a request: the listing's author.
    // If postAuthorPublicKey is known, compare directly with me.
    // Otherwise fallback based on listing kind: Need's author is buyer, Offer's author is seller.
    const isAuthor = isParty && (tx.postAuthorPublicKey != null
        ? tx.postAuthorPublicKey === me
        : (tx.postType === 'need' ? isPayer : isPayee));

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

    const needsMe = isParty && (state === 'to-answer' || state === 'to-release');

    let pressing = false;
    if (needsMe) {
        if (state === 'to-answer') {
            pressing = true;
        } else if (state === 'to-release') {
            const createdMs = tx.createdAt ? Date.parse(tx.createdAt) : NaN;
            pressing = !Number.isNaN(createdMs) && (now - createdMs >= SEVEN_DAYS_MS);
        }
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

// ── A listing's page and its card (DESIGN-deals-fable §3.2, §3.3; slice S4) ──────────────────────────────────────────

/**
 * Whom a member stands for on a deal: themselves when they are its buyer or its seller, else an enterprise they keep that
 * is (`keeperOf`, the node's balance read: the enterprises they may drive, decided by the same rule as the node's
 * canOperateTreasury). null: a stranger to the deal, who is shown nothing of it.
 *
 * The node lets exactly these act on it: a step names its key (confirmer, canceller, author, requester), and the
 * signature must be that key's, or a keeper's of that enterprise (apps/server routes/marketplace.ts assertActorEntitled).
 * A member who is a side themselves acts as themselves, so a keeper paid by their own enterprise's deal is its payee,
 * never the enterprise releasing its own wages (the node's two-person rule, engine/escrow.ts completePostTransaction).
 */
export function dealSideOf(tx: DealRow, me: string, keeperOf: readonly string[] = []): string | null {
    if (!me) return null;
    if (tx.buyerPublicKey === me || tx.sellerPublicKey === me) return me;
    if (keeperOf.includes(tx.buyerPublicKey)) return tx.buyerPublicKey;
    if (keeperOf.includes(tx.sellerPublicKey)) return tx.sellerPublicKey;
    return null;
}

/** What a member may do on one deal, and as whom (dealMoves). */
export interface DealMoves<T extends DealRow = DealRow> {
    tx: T;
    /** The key the step is named with: the member's own, or the enterprise's they keep. */
    actingAs: string;
    asKeeper: boolean;
    step: DealStep;
    /** Release the Beans held: the payer (engine/escrow.ts completePostTransaction). */
    release: boolean;
    /** Cancel the hold, the Beans back to the payer: either side, as themselves (cancelPostTransaction). */
    cancelHold: boolean;
    /** Approve or deny a request: the listing's author (approvePostRequest, rejectPostRequest). */
    answer: boolean;
    /** Withdraw a request: the one who asked (cancelPostRequest). */
    withdraw: boolean;
}

/**
 * The one rule for which deal buttons a member sees, both apps: an action only for someone the node lets take it, and
 * none hidden from them. null for a stranger to the deal.
 *
 * A keeper acts as the enterprise through the enterprise's own doors (apps/server routes/treasury.ts): Release where the
 * enterprise pays (/complete), Approve and Deny on its listings (/approve, /reject). The node has no door for a keeper to
 * cancel a hold or withdraw a request as the enterprise (the signature check holds every body key to the signer, so
 * /api/marketplace/transactions/cancel named with the enterprise's key is refused), so neither shows to a keeper; the other
 * side of the deal, a member, cancels as themselves. One exception: a keeper's own request on their enterprise's listing
 * shows Withdraw, theirs, and not Deny as the enterprise, though the node would take either.
 */
export function dealMoves<T extends DealRow>(tx: T, me: string, keeperOf: readonly string[] = [], now: number = Date.now()): DealMoves<T> | null {
    const actingAs = dealSideOf(tx, me, keeperOf);
    if (!actingAs) return null;
    const step = dealStep(tx, actingAs, now);
    const held = tx.status === 'pending';
    const asKeeper = actingAs !== me;
    return {
        tx,
        actingAs,
        asKeeper,
        step,
        release: held && tx.buyerPublicKey === actingAs,
        cancelHold: held && !asKeeper,
        answer: step.state === 'to-answer',
        withdraw: step.state === 'asked' && !asKeeper,
    };
}

/** The listing as the page shows it: enough to say who its own people are and what kind of deal it makes. */
export interface DealListing {
    id: string;
    authorPublicKey: string;
    type?: string | null;
    status?: string | null;
}

/** Every deal on one listing that the member stands on, sorted for its page (listingDeals). */
export interface ListingDeals<T extends DealRow = DealRow> {
    /** Its own people: its author, or a keeper of the enterprise that wrote it. */
    own: boolean;
    /** Requests waiting on its own people to answer, newest first. */
    requests: DealMoves<T>[];
    /** Deals held in trust the member stands on: for its own people every deal on it (a recurring listing can have several). */
    held: DealMoves<T>[];
    /** The member's own request, still waiting. */
    asked: DealMoves<T> | null;
    /** The member's last finished deal on it, for "You've had this before" (never for its own people). */
    lastDone: DealMoves<T> | null;
    /** A one-off listing in someone else's deal just now. */
    takenByOther: boolean;
    /** Accept, Ask or Offer to fulfil may show: not its own people, and no deal of the member's own under way on it. */
    canTakeUp: boolean;
}

const newestFirst = (a: DealMoves, b: DealMoves) => (b.tx.createdAt || '').localeCompare(a.tx.createdAt || '');
const isOpen = (m: DealMoves) => m.tx.status === 'pending' || m.tx.status === 'requested';

/**
 * What a listing's page shows of its deals, for the member reading it (DESIGN-deals-fable §3.2): `txs` are the deals the
 * app holds (the member's own, and for a keeper the enterprise's); a deal on another listing, or one the member is a
 * stranger to, counts for nothing.
 */
export function listingDeals<T extends DealRow>(
    txs: readonly T[],
    listing: DealListing,
    me: string,
    keeperOf: readonly string[] = [],
    now: number = Date.now(),
): ListingDeals<T> {
    const own = !!me && (listing.authorPublicKey === me || keeperOf.includes(listing.authorPublicKey));
    const seen = new Set<string>();
    const mine: DealMoves<T>[] = [];
    for (const tx of txs) {
        if (tx.postId !== listing.id) continue;
        if (tx.id) {
            if (seen.has(tx.id)) continue;
            seen.add(tx.id);
        }
        // Who answers a request is the listing's author: said from the listing when the deal's row doesn't carry it.
        const row: T = tx.postAuthorPublicKey != null ? tx : { ...tx, postAuthorPublicKey: listing.authorPublicKey, postType: tx.postType ?? listing.type ?? null };
        const m = dealMoves(row, me, keeperOf, now);
        if (m) mine.push(m);
    }
    mine.sort(newestFirst);
    const openAny = mine.some(isOpen);
    const done = own || openAny ? [] : mine.filter(m => m.tx.status === 'completed')
        .sort((a, b) => (b.tx.completedAt || b.tx.createdAt || '').localeCompare(a.tx.completedAt || a.tx.createdAt || ''));
    return {
        own,
        requests: own ? mine.filter(m => m.answer) : [],
        held: mine.filter(m => m.tx.status === 'pending'),
        asked: mine.find(m => m.withdraw) ?? null,
        lastDone: done[0] ?? null,
        takenByOther: !own && listing.status === 'pending' && !openAny,
        // One open deal per member per listing (the node's deal_open): the member's own key, not an enterprise they keep.
        canTakeUp: !own && !mine.some(m => m.actingAs === me && isOpen(m)),
    };
}

/** A card's chip in the feed (§3.3): a deal of the member's own on that listing, held in trust or asked for. */
export type ListingChip = 'in-trust' | 'asked';

/**
 * The chip for each listing the member has a deal under way on, by listing id: their own deals only (they are its buyer
 * or its seller), so a card never tells a stranger who traded. Held in trust wins over a request.
 */
export function listingChips(txs: readonly DealRow[], me: string): Map<string, ListingChip> {
    const chips = new Map<string, ListingChip>();
    if (!me) return chips;
    for (const tx of txs) {
        if (!tx.postId || (tx.buyerPublicKey !== me && tx.sellerPublicKey !== me)) continue;
        if (tx.status === 'pending') chips.set(tx.postId, 'in-trust');
        else if (tx.status === 'requested' && !chips.has(tx.postId)) chips.set(tx.postId, 'asked');
    }
    return chips;
}

/** The chip's words, both apps. */
export function listingChipWords(chip: ListingChip): string {
    return chip === 'in-trust' ? t('🤝 IN TRUST') : t('✋ ASKED');
}

/** The listing page's lines about its deals (§3.2), one set for both apps. Amounts and dates come formatted, except a row's. */
export const listingDealLines = {
    /**
     * One row of the deals under way, for the listing's own people, from the deal's own amount: a free deal (a thing lent
     * for nothing, a free Offer taken up) has nothing held, and says so rather than "0 Beans held".
     */
    heldRow: (name: string, credits: number, date: string) => (credits > 0
        ? t('{name} · {n} Beans held · since {date}', { name, n: formatNumber(credits), date })
        : t('{name} · no Beans held · since {date}', { name, date })),
    underWay: (n: number) => t('Deals under way: {n}', { n }),
    /** A keeper's note: the steps on this listing are taken as the enterprise. */
    actingFor: (name: string) => t('You act for {name} here.', { name }),
    /** A helper on a Need, approved, from the deal's own amount: the Beans are held for them, and on a free Need none are. */
    helping: (credits: number) => (credits > 0
        ? t("You're helping with this · {n} Beans held for you", { n: formatNumber(credits) })
        : t("You're helping with this · no Beans held")),
    offeredToHelp: (name: string) => t('You offered to help · waiting on {name}', { name }),
    askedToBorrow: (name: string) => t('You asked to borrow it · nothing is held until {name} says yes', { name }),
    takenByOther: () => t('Taken up by someone else for now.'),
    hadBefore: (date: string) => t("You've had this before · done {date}", { date }),
    /** Rate that finished deal, from the listing. */
    review: () => t('⭐ Review'),
    /**
     * A deal a door named that is over (an alert for a request declined, a deal cancelled, released or settled): what
     * became of it, from its status, above the listing as it stands for the reader now. Null while it is open.
     */
    finished: (status: string): string | null => {
        if (status === 'pending' || status === 'requested') return null;
        if (status === 'completed') return t('That deal is done.');
        if (status === 'rejected' || status === 'declined') return t('That request was declined.');
        return t('That deal was cancelled.');
    },
};

/** A deal as Release reads it: what it holds, and the time it was struck for (none on a fixed price). */
export interface ReleaseDeal {
    credits?: number | null;
    hours?: number | null;
}

/** The listing as Release reads it: how it is priced, and whether it is lent. */
export interface ReleaseListing {
    priceType?: string | null;
    lendable?: boolean | number | null;
}

/**
 * What a payer's Release moves, as the node pays it (apps/server engine/escrow.ts completePostTransaction): a deal
 * struck for a time pays at its own rate (what it holds over the time it was struck for) for the time confirmed; a fixed
 * price, a loan for one fee, or a deal with no time on it pays what it holds. `units` is the time confirmed, undefined
 * when none is asked for; a time that is not above 0 releases nothing (Release is off for it).
 */
export function releaseAmount(deal: ReleaseDeal, units: number | undefined, listing: ReleaseListing): number {
    const held = Number(deal.credits ?? 0);
    const booked = Number(deal.hours);
    const oneFeeLoan = !!listing.lendable && (listing.priceType || 'fixed') === 'fixed';
    if (!(Number.isFinite(booked) && booked > 0) || oneFeeLoan || units === undefined) return held;
    if (!(Number.isFinite(units) && units > 0)) return 0;
    return units === booked ? held : (held / booked) * units;
}

/**
 * The line in a payer's Release confirm, both apps, the panel's and each row's: the Beans it moves (releaseAmount, to the
 * cent) and to whom, or, for a time typed that could mean two numbers, why it can't be read. `typed` is the time as
 * parsed (parseAmount), null where none is asked for (a fixed price).
 */
export function releaseLine(deal: ReleaseDeal, listing: ReleaseListing, typed: ParsedAmount | null, payeeName: string): string {
    if (typed && !typed.ok && isAmbiguousAmount(typed.refusal)) return amountRefusalWords(typed.refusal);
    const units = typed ? (typed.ok ? typed.value : NaN) : undefined;
    const n = Math.round(releaseAmount(deal, units, listing) * 100) / 100;
    return t('Transferring {n} B to {name}', { n, name: payeeName });
}
