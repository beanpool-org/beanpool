/**
 * Loans maths for the Tool shed (scratch/tools/DESIGN-tool-template-fable.md §3.1, §6 T1.1;
 * DESIGN-tool-library-fable.md §2.3-2.6; DESIGN-shops-and-tools-fable.md §0 row 9, §12 S3).
 *
 * Plain functions only: pure arithmetic and validations, matching S3 lendable Offers semantics.
 */
import {
    LEND_MAX_DAYS_MAX,
    LENDABLE_PRICE_TYPES,
    dealQuantityUnit,
    isLendablePriceType,
    lendBackAroundOf,
    loanDays,
    type DealQuantityUnit,
} from '../../lending.js';
import {
    THINGS_LEND_TERMS_CHARS,
    THINGS_OWNER_NOTE_CHARS,
    THINGS_REPLACEMENT_VALUE_CHARS,
} from './doc.js';

export {
    LEND_MAX_DAYS_MAX,
    LENDABLE_PRICE_TYPES,
    dealQuantityUnit,
    isLendablePriceType,
    lendBackAroundOf,
    loanDays,
    type DealQuantityUnit,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Total Beans fee for a loan, unrounded: the amount the node draws (apps/server/src/engine/escrow.ts, `post.credits * hours`
 * or `post.credits`), cents included, so a 0.4-Bean loan is never quoted as free.
 * - Free loan (0 or negative credits): 0 Beans
 * - Fixed price: one fee of `credits` Beans (regardless of duration/units)
 * - Daily price: `credits * units` Beans
 * - Weekly price: `credits * units` Beans
 * Returns 0 if units is not a positive finite number for daily/weekly.
 */
export function loanTotalBeans(credits: number, priceType: string | null | undefined, units: unknown): number {
    if (typeof credits !== 'number' || !Number.isFinite(credits) || credits <= 0) return 0;
    const type = priceType || 'fixed';
    if (type === 'fixed') return credits;
    if (type === 'daily' || type === 'weekly') {
        if (typeof units !== 'number' || !Number.isFinite(units) || units <= 0) return 0;
        return credits * units;
    }
    return 0;
}

/** Whether a loan is currently overdue: its backAround time is in the past compared to now. */
export function isLoanOverdue(backAround: string | null | undefined, now: number): boolean {
    if (typeof backAround !== 'string' || !Number.isFinite(now)) return false;
    const at = Date.parse(backAround);
    if (!Number.isFinite(at)) return false;
    return at < now;
}

/**
 * Days remaining until a loan is due back. Positive integer if in future,
 * 0 if due today, negative integer if overdue. Null if backAround is invalid.
 */
export function loanDaysRemaining(backAround: string | null | undefined, now: number): number | null {
    if (typeof backAround !== 'string' || !Number.isFinite(now)) return null;
    const at = Date.parse(backAround);
    if (!Number.isFinite(at)) return null;
    const diff = at - now;
    if (diff < 0) {
        return Math.floor(diff / DAY_MS); // Overdue: -1, -2, etc.
    }
    return Math.floor(diff / DAY_MS); // 0 if due today (<24h), 1+ if days ahead
}

/** Whether lendMaxDays is a valid loan period: whole integer between 1 and 365 days. */
export function isValidLendMaxDays(days: unknown): boolean {
    return typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= LEND_MAX_DAYS_MAX;
}

/** Whether replacementValue is valid: string up to 40 characters in lender's words. */
export function isValidReplacementValue(val: unknown): boolean {
    return typeof val === 'string' && val.length <= THINGS_REPLACEMENT_VALUE_CHARS;
}

/** Whether lendTerms is valid: string up to 300 characters. */
export function isValidLendTerms(terms: unknown): boolean {
    return typeof terms === 'string' && terms.length <= THINGS_LEND_TERMS_CHARS;
}

/** Whether ownerNote is valid: string up to 500 characters. */
export function isValidOwnerNote(note: unknown): boolean {
    return typeof note === 'string' && note.length <= THINGS_OWNER_NOTE_CHARS;
}
