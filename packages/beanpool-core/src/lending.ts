/**
 * A lendable Offer (scratch/tools/DESIGN-tool-library-fable.md §2.3-2.6; DESIGN-shops-and-tools-fable.md §0 row 9, §12 S3):
 * one borrower at a time, and back on the board when the loan is done. The arithmetic of a loan's length, here so the node
 * and both apps say the same "back around" date.
 *
 * A loan's deal keeps its quantity where every deal keeps one (marketplace_transactions.hours): in the price's own units for
 * a fee per day or per week, as any deal on such a price, and in days for one fee (a Free loan is one fee of 0 Beans). A
 * loan is never priced by the hour or the month.
 *
 * Plain functions only: this file is in the barrel the phone app bundles (barrel-is-universal.test.ts).
 */

/** How a loan's fee may be counted: one fee (Free is 0), per day, or per week. */
export const LENDABLE_PRICE_TYPES = ['fixed', 'daily', 'weekly'] as const;

/** The longest loan a lender may name (`lend_max_days`), in days: a year. */
export const LEND_MAX_DAYS_MAX = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a loan may be priced this way (LENDABLE_PRICE_TYPES). */
export function isLendablePriceType(priceType: unknown): boolean {
    return (LENDABLE_PRICE_TYPES as readonly unknown[]).includes(priceType ?? 'fixed');
}

/**
 * A loan's length in days from its deal's quantity: the days themselves for one fee or a fee per day, seven a week for a fee
 * per week. Null when the deal holds no quantity (a loan asked for by an app that never sends one), or holds one that is not
 * a positive finite number, or the price is not a loan's.
 */
export function loanDays(priceType: string | null | undefined, units: unknown): number | null {
    if (typeof units !== 'number' || !Number.isFinite(units) || units <= 0) return null;
    const type = priceType || 'fixed';
    if (type === 'fixed' || type === 'daily') return units;
    if (type === 'weekly') return units * 7;
    return null;
}

/**
 * When a loan is due back: the day it was handed over (the listing's `accepted_at`) plus its length, as an ISO time. Null when
 * either is unknown. A date, never a name: every reader of the listing may be told it (design §2.3).
 */
export function lendBackAroundOf(acceptedAt: string | null | undefined, priceType: string | null | undefined, units: unknown): string | null {
    const days = loanDays(priceType, units);
    const from = typeof acceptedAt === 'string' ? Date.parse(acceptedAt) : NaN;
    if (days === null || !Number.isFinite(from)) return null;
    const back = from + days * DAY_MS;
    return Number.isFinite(back) && Math.abs(back) <= 8.64e15 ? new Date(back).toISOString() : null;
}
