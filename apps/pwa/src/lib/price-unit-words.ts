/**
 * The words the web's deal screens write for a listing's price unit (`price_type`): the unit after a price, the label over
 * the quantity a member gives when taking a listing up and the one a payer confirms at Release, the quantity in the
 * commitment sentence and on a request, and a keeper's Release prompt on an enterprise's deal. One switch per sentence,
 * exhaustive over core's PRICE_UNITS, so a new unit is a compile error here until it has its own words.
 *
 * A listing priced per kilo (`per_kg`) asks for the weight in kilos, as an hourly one asks for hours (Marty, 25 Nov 2026:
 * "yes ask for the weight like hours"); its words say kilos where a time unit's say hours, days or years.
 *
 * Used by pages/MarketplacePage.tsx and pages/TreasuryDetailPage.tsx; the phone has the same words in
 * apps/native/utils/price-unit-words.ts.
 */
import { isPriceUnit, t, tn, type DealQuantityUnit } from '@beanpool/core';

/** A listing's price unit after its amount ("/Hr"), as the phone's Market writes it; nothing for a total or a price each. */
export function priceUnitSuffix(priceType: string | null | undefined): string {
    if (!isPriceUnit(priceType)) return '';
    switch (priceType) {
        case 'hourly': return t('/Hr', undefined, 'price per hour');
        case 'daily': return t('/Dy', undefined, 'price per day');
        case 'weekly': return t('/Wk', undefined, 'price per week');
        case 'monthly': return t('/Mo', undefined, 'price per month');
        case 'yearly': return t('/Yr', undefined, 'price per year');
        case 'per_kg': return t('/kg', undefined, 'price per kilo');
        case 'fixed':
        case 'each':
            return '';
        default: {
            const _exhaustive: never = priceType;
            return _exhaustive;
        }
    }
}

/** The label over the quantity a payer confirms when releasing a deal priced by the hour, day, week, month, year or kilo. */
export function actualWorkedLabel(priceType: string | null | undefined): string {
    if (!isPriceUnit(priceType)) return t('ACTUAL UNITS WORKED');
    switch (priceType) {
        case 'hourly': return t('ACTUAL HOURS WORKED');
        case 'daily': return t('ACTUAL DAYS WORKED');
        case 'weekly': return t('ACTUAL WEEKS WORKED');
        case 'monthly': return t('ACTUAL MONTHS WORKED');
        case 'yearly': return t('ACTUAL YEARS WORKED');
        case 'per_kg': return t('ACTUAL WEIGHT (KILOS)');
        case 'fixed':
        case 'each':
            return t('ACTUAL UNITS WORKED');
        default: {
            const _exhaustive: never = priceType;
            return _exhaustive;
        }
    }
}

/** The label over the quantity a member gives when taking up a listing priced by the hour, day, week, month, year or kilo. */
export function estimatedLabel(priceType: string | null | undefined): string {
    if (!isPriceUnit(priceType)) return t('ESTIMATED UNITS');
    switch (priceType) {
        case 'hourly': return t('ESTIMATED HOURS');
        case 'daily': return t('ESTIMATED DAYS');
        case 'weekly': return t('ESTIMATED WEEKS');
        case 'monthly': return t('ESTIMATED MONTHS');
        case 'yearly': return t('ESTIMATED YEARS');
        case 'per_kg': return t('WEIGHT (KILOS)');
        case 'fixed':
        case 'each':
            return t('ESTIMATED UNITS');
        default: {
            const _exhaustive: never = priceType;
            return _exhaustive;
        }
    }
}

/** The quantity in the commitment sentence ("3 hr", "2.5 kg"); null for a total or a price each, which name none. */
export function estimateLength(priceType: string | null | undefined, n: number): string | null {
    if (!isPriceUnit(priceType)) return null;
    switch (priceType) {
        case 'hourly': return t('{n} hr', { n }, 'a number of hours');
        case 'daily': return t('{n} d', { n }, 'a number of days');
        case 'weekly': return t('{n} w', { n }, 'a number of weeks');
        case 'monthly': return t('{n} m', { n }, 'a number of months');
        case 'yearly': return t('{n} yr', { n }, 'a number of years');
        case 'per_kg': return t('{n} kg', { n }, 'a weight in kilos');
        case 'fixed':
        case 'each':
            return null;
        default: {
            const _exhaustive: never = priceType;
            return _exhaustive;
        }
    }
}

/** A request's quantity, in the listing price's own unit ("2 days", "2.5 kilos", or "for {n} days" for a loan). */
export function requestQuantityWords(unit: DealQuantityUnit | null, isLoan: boolean, n: number): string {
    if (isLoan) {
        if (unit === 'week') return tn(n, 'for {n} week', 'for {n} weeks');
        return tn(n, 'for {n} day', 'for {n} days');
    }
    if (unit === 'day') return tn(n, '{n} day', '{n} days');
    if (unit === 'week') return tn(n, '{n} week', '{n} weeks');
    if (unit === 'month') return tn(n, '{n} month', '{n} months');
    if (unit === 'year') return tn(n, '{n} year', '{n} years');
    if (unit === 'kilo') return tn(n, '{n} kilo', '{n} kilos');
    if (unit === 'hour') return tn(n, '{n} hours estimated', '{n} hours estimated');
    return '';
}

/** A keeper's Release prompt on an enterprise's deal priced by quantity, and the words when what they typed is not one. */
export function enterpriseReleaseCopy(priceType: string | null | undefined, postTitle?: string): { question: string; invalid: string } {
    const fallback = {
        question: postTitle ? t('Enter units worked for "{title}":', { title: postTitle }) : t('Enter units worked for "deal":'),
        invalid: t('Please enter a valid positive quantity.'),
    };
    if (!isPriceUnit(priceType)) return fallback;
    switch (priceType) {
        case 'hourly':
            return {
                question: postTitle ? t('Enter hours worked for "{title}":', { title: postTitle }) : t('Enter hours worked for "deal":'),
                invalid: t('Please enter a valid positive number of hours.'),
            };
        case 'daily':
            return {
                question: postTitle ? t('Enter days worked for "{title}":', { title: postTitle }) : t('Enter days worked for "deal":'),
                invalid: t('Please enter a valid positive number of days.'),
            };
        case 'weekly':
            return {
                question: postTitle ? t('Enter weeks worked for "{title}":', { title: postTitle }) : t('Enter weeks worked for "deal":'),
                invalid: t('Please enter a valid positive number of weeks.'),
            };
        case 'monthly':
            return {
                question: postTitle ? t('Enter months worked for "{title}":', { title: postTitle }) : t('Enter months worked for "deal":'),
                invalid: t('Please enter a valid positive number of months.'),
            };
        case 'yearly':
            return {
                question: postTitle ? t('Enter years worked for "{title}":', { title: postTitle }) : t('Enter years worked for "deal":'),
                invalid: t('Please enter a valid positive number of years.'),
            };
        case 'per_kg':
            return {
                question: postTitle ? t('Enter the weight in kilos for "{title}":', { title: postTitle }) : t('Enter the weight in kilos for "deal":'),
                invalid: t('Please enter a valid positive number of kilos.'),
            };
        case 'fixed':
        case 'each':
            return fallback;
        default: {
            const _exhaustive: never = priceType;
            return _exhaustive;
        }
    }
}
