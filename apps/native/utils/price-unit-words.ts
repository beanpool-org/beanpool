/**
 * The words the phone's deal screens write for a listing's price unit (`price_type`): the unit after a price, the label over
 * the quantity a member commits when taking a listing up and the one a payer confirms at Release, the commitment and
 * request sentences in the price's own unit, and a keeper's Release prompt on an enterprise's deal. One switch per
 * sentence, exhaustive over core's PRICE_UNITS, so a new unit is a compile error here until it has its own words.
 *
 * A listing priced per kilo (`per_kg`) asks for the weight in kilos, as an hourly one asks for hours (Marty, 25 Nov 2026:
 * "yes ask for the weight like hours"); its words say kilos where a time unit's say hours, days or years.
 *
 * Used by app/post/[id].tsx and app/treasury-manage.tsx; the web has the same words in apps/pwa/src/lib/price-unit-words.ts.
 * Plain functions only (no React Native import), so a plain vitest reads them (utils/__tests__/price-unit-words.test.ts).
 */
import { feeOf, formatHundredths, isHundredths, isPriceUnit, t, tn, type DealQuantityUnit } from '@beanpool/core';

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

/**
 * The commitment sentence for an Offer, in the price's own unit. Never a loan's: nothing is held while a loan is asked for.
 * `amount_c`: what the deal holds, whole hundredths of a Bean, written by formatHundredths.
 */
export function committedOfferWords(unit: DealQuantityUnit | null, hours: number, amount_c: number): string {
    const credits = formatHundredths(amount_c);
    if (unit === 'day') {
        return tn(
            hours,
            'You have committed {credits} credits ({n} day) to a Trust Wallet for this offer.',
            'You have committed {credits} credits ({n} days) to a Trust Wallet for this offer.',
            { credits }
        );
    }
    if (unit === 'week') {
        return tn(
            hours,
            'You have committed {credits} credits ({n} week) to a Trust Wallet for this offer.',
            'You have committed {credits} credits ({n} weeks) to a Trust Wallet for this offer.',
            { credits }
        );
    }
    if (unit === 'month') {
        return tn(
            hours,
            'You have committed {credits} credits ({n} month) to a Trust Wallet for this offer.',
            'You have committed {credits} credits ({n} months) to a Trust Wallet for this offer.',
            { credits }
        );
    }
    if (unit === 'year') {
        return tn(
            hours,
            'You have committed {credits} credits ({n} year) to a Trust Wallet for this offer.',
            'You have committed {credits} credits ({n} years) to a Trust Wallet for this offer.',
            { credits }
        );
    }
    if (unit === 'kilo') {
        return tn(
            hours,
            'You have committed {credits} credits ({n} kilo) to a Trust Wallet for this offer.',
            'You have committed {credits} credits ({n} kilos) to a Trust Wallet for this offer.',
            { credits }
        );
    }
    if (unit === 'hour') {
        return t('You have committed {credits} credits ({hours} hours) to a Trust Wallet for this offer.', { credits, hours });
    }
    return t('You have committed {credits} credits to a Trust Wallet for this offer.', { credits });
}

/** What reaches the payee of a deal holding `amount_c`: the amount less the Commons fee, truncated once (core feeOf). */
export function netWords(amount_c: unknown): string {
    return isHundredths(amount_c) && amount_c >= 0 ? formatHundredths(amount_c - feeOf(amount_c)) : formatHundredths(null);
}

/**
 * The commitment sentence for a Need: in the price's own unit (a Need is never a loan). `amount_c`: what the deal holds,
 * whole hundredths; the net is what reaches the helper, the amount less the Commons fee as the node takes it (core feeOf).
 */
export function requestedNeedWords(unit: DealQuantityUnit | null, hours: number, amount_c: number): string {
    const credits = formatHundredths(amount_c);
    const net = netWords(amount_c);
    if (unit === 'day') {
        return tn(
            hours,
            'You have requested to earn {credits} credits ({n} day) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            'You have requested to earn {credits} credits ({n} days) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            { credits, net }
        );
    }
    if (unit === 'week') {
        return tn(
            hours,
            'You have requested to earn {credits} credits ({n} week) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            'You have requested to earn {credits} credits ({n} weeks) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            { credits, net }
        );
    }
    if (unit === 'month') {
        return tn(
            hours,
            'You have requested to earn {credits} credits ({n} month) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            'You have requested to earn {credits} credits ({n} months) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            { credits, net }
        );
    }
    if (unit === 'year') {
        return tn(
            hours,
            'You have requested to earn {credits} credits ({n} year) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            'You have requested to earn {credits} credits ({n} years) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            { credits, net }
        );
    }
    if (unit === 'kilo') {
        return tn(
            hours,
            'You have requested to earn {credits} credits ({n} kilo) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            'You have requested to earn {credits} credits ({n} kilos) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            { credits, net }
        );
    }
    if (unit === 'hour') {
        return t('You have requested to earn {credits} credits ({hours} hours) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.', { credits, hours, net });
    }
    return t('You have requested to earn {credits} credits ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.', { credits, net });
}

/** The unit after a price: per hour, day, week, month, year or kilo, or none for a total. */
export function priceUnitWords(priceType: string | null | undefined): string {
    if (!isPriceUnit(priceType)) return '';
    switch (priceType) {
        case 'hourly': return t('/ Hr', undefined, 'price per hour');
        case 'daily': return t('/ Dy', undefined, 'price per day');
        case 'weekly': return t('/ Wk', undefined, 'price per week');
        case 'monthly': return t('/ Mo', undefined, 'price per month');
        case 'yearly': return t('/ Yr', undefined, 'price per year');
        case 'per_kg': return t('/ kg', undefined, 'price per kilo');
        case 'fixed':
        case 'each':
            return '';
        default: {
            const _exhaustive: never = priceType;
            return _exhaustive;
        }
    }
}

/** The label over the quantity a payer confirms at Release, for a deal priced by the hour, day, week, month, year or kilo. */
export function confirmWorkedLabel(priceType: string | null | undefined): string {
    if (!isPriceUnit(priceType)) return t('CONFIRM ACTUAL UNITS WORKED');
    switch (priceType) {
        case 'hourly': return t('CONFIRM ACTUAL HOURS WORKED');
        case 'daily': return t('CONFIRM ACTUAL DAYS WORKED');
        case 'weekly': return t('CONFIRM ACTUAL WEEKS WORKED');
        case 'monthly': return t('CONFIRM ACTUAL MONTHS WORKED');
        case 'yearly': return t('CONFIRM ACTUAL YEARS WORKED');
        case 'per_kg': return t('CONFIRM ACTUAL WEIGHT (KILOS)');
        case 'fixed':
        case 'each':
            return t('CONFIRM ACTUAL UNITS WORKED');
        default: {
            const _exhaustive: never = priceType;
            return _exhaustive;
        }
    }
}

/** The label, screen-reader label, and placeholder for the quantity a member commits when taking up a listing priced by quantity. */
export function trustCommitmentCopy(priceType: string | null | undefined): { label: string; accessibilityLabel: string; placeholder: string } {
    const fallback = {
        label: t('TRUST COMMITMENT (UNITS)'),
        accessibilityLabel: t('Trust commitment in units'),
        placeholder: t('Units'),
    };
    if (!isPriceUnit(priceType)) return fallback;
    switch (priceType) {
        case 'hourly':
            return {
                label: t('TRUST COMMITMENT (HOURS)'),
                accessibilityLabel: t('Trust commitment in hours'),
                placeholder: t('Hours'),
            };
        case 'daily':
            return {
                label: t('TRUST COMMITMENT (DAYS)'),
                accessibilityLabel: t('Trust commitment in days'),
                placeholder: t('Days'),
            };
        case 'weekly':
            return {
                label: t('TRUST COMMITMENT (WEEKS)'),
                accessibilityLabel: t('Trust commitment in weeks'),
                placeholder: t('Weeks'),
            };
        case 'monthly':
            return {
                label: t('TRUST COMMITMENT (MONTHS)'),
                accessibilityLabel: t('Trust commitment in months'),
                placeholder: t('Months'),
            };
        case 'yearly':
            return {
                label: t('TRUST COMMITMENT (YEARS)'),
                accessibilityLabel: t('Trust commitment in years'),
                placeholder: t('Years'),
            };
        case 'per_kg':
            return {
                label: t('WEIGHT (KILOS)'),
                accessibilityLabel: t('Weight in kilos'),
                placeholder: t('Kilos'),
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

/** Modal heading, prompt, and validation copy when a keeper confirms an enterprise's deal priced by quantity. */
export function enterpriseWorkedCopy(priceType: string | null | undefined, title: string): {
    heading: string;
    prompt: string;
    invalidTitle: string;
    invalidMessage: string;
} {
    const fallback = {
        heading: t('Confirm Units Worked'),
        prompt: t('Enter actual units worked for "{title}":', { title }),
        invalidTitle: t('Invalid Quantity'),
        invalidMessage: t('Please enter a valid positive quantity.'),
    };
    if (!isPriceUnit(priceType)) return fallback;
    switch (priceType) {
        case 'hourly':
            return {
                heading: t('Confirm Hours Worked'),
                prompt: t('Enter actual hours worked for "{title}":', { title }),
                invalidTitle: t('Invalid Hours'),
                invalidMessage: t('Please enter a valid positive number of hours.'),
            };
        case 'daily':
            return {
                heading: t('Confirm Days Worked'),
                prompt: t('Enter actual days worked for "{title}":', { title }),
                invalidTitle: t('Invalid Days'),
                invalidMessage: t('Please enter a valid positive number of days.'),
            };
        case 'weekly':
            return {
                heading: t('Confirm Weeks Worked'),
                prompt: t('Enter actual weeks worked for "{title}":', { title }),
                invalidTitle: t('Invalid Weeks'),
                invalidMessage: t('Please enter a valid positive number of weeks.'),
            };
        case 'monthly':
            return {
                heading: t('Confirm Months Worked'),
                prompt: t('Enter actual months worked for "{title}":', { title }),
                invalidTitle: t('Invalid Months'),
                invalidMessage: t('Please enter a valid positive number of months.'),
            };
        case 'yearly':
            return {
                heading: t('Confirm Years Worked'),
                prompt: t('Enter actual years worked for "{title}":', { title }),
                invalidTitle: t('Invalid Years'),
                invalidMessage: t('Please enter a valid positive number of years.'),
            };
        case 'per_kg':
            return {
                heading: t('Confirm Weight (Kilos)'),
                prompt: t('Enter the actual weight in kilos for "{title}":', { title }),
                invalidTitle: t('Invalid Weight'),
                invalidMessage: t('Please enter a valid positive number of kilos.'),
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
