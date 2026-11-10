/**
 * A listing's money on the phone, in whole hundredths of a Bean (@beanpool/core hundredths.ts; DESIGN-atomic-beans-fable.md
 * M2): what a deal on it comes to before it is asked for, and its price as the member types it again. Pure.
 */
import { dealAmountFor, formatHundredths, isHundredths } from '@beanpool/core';

/**
 * What `quantity` units at `price_c` come to (core dealAmountFor: the figure the node holds for the deal, the product
 * truncated once), or null when it can't be one: a price that isn't whole hundredths (a listing whose figure the phone
 * doesn't hold), a quantity that isn't a number above 0, or a product past what is exact. Never throws, so a render never
 * does (the web's MarketplacePage dealAmountOrNull, the same rule).
 */
export function dealAmountOrNull(price_c: unknown, quantity: number): number | null {
    if (!isHundredths(price_c) || price_c < 0 || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return null;
    try {
        return dealAmountFor(price_c, quantity);
    } catch {
        return null;
    }
}

/**
 * A price as the member types it again, the edit box's first text: formatHundredths' figure in their language without the
 * thousands marks English is grouped with ("1,234.50" → "1234.50"), so core parseHundredths reads it back as the same
 * price. Empty for no figure.
 */
export function priceAsTyped(price_c: unknown): string {
    return isHundredths(price_c) ? formatHundredths(price_c).replace(/,(?=\d{3}(?!\d))/g, '') : '';
}
