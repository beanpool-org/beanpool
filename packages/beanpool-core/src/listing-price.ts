/**
 * A listing priced at 0 Beans reads as free, everywhere a member sees its price, on the phone and the web alike
 * (Marty, 9 Nov, looking at a Need: "WILLING TO PAY 0 🫘 ... should it have been a need or an offer? and is it free? its
 * confusing?"). One rule, here, so the two apps cannot drift:
 *
 *   - An Offer at 0 says "Free"; a Need at 0 says "Free" on a card or row and "Free help wanted" in the detail page's price box.
 *   - A price by the hour, day, week or month at 0 is free too: "Free", never "Free /hr".
 *   - Free draws no Beans icon and no unit; the figure is words, so a screen reader reads "Free", not "0".
 *   - Only a number that is 0 is free. A price the node did not send (none, "", text) is not free: the card keeps its "?".
 */
import { t, word } from './words.js';

/** The words a free listing's price becomes. `short`'s key is the one the shop front, Home and the lobby already use. */
export const FREE_PRICE_WORDS = {
    /** A card, a row, a pin's card, a share line: the whole price. */
    short: word('Free', 'a listing with no price'),
    /** The detail page's price box on a Need: someone is looking for help and offers nothing for it. */
    needBox: word('Free help wanted'),
    /** The price box's label over a free Need, where "Willing to pay" would contradict the figure under it. */
    needLabel: word('Price'),
} as const;

/** Where the words are shown: `short` on a card, a row or a line; `box` in the detail page's price box. */
export type FreePriceForm = 'short' | 'box';

/** True only for a price that is a number and 0 (a number or a numeric string): none, "", text and NaN are not free. */
export function isFreePrice(credits: unknown): boolean {
    if (typeof credits === 'number') return credits === 0;
    if (typeof credits === 'string' && credits.trim() !== '') return Number(credits.trim()) === 0;
    return false;
}

/**
 * What a listing's price reads when it is free; null when it has a price (the caller draws the figure as it always did).
 * `type` is the listing's own ('offer' or 'need'); any other value reads as an Offer would.
 */
export function freePriceWords(credits: unknown, type: string | null | undefined, form: FreePriceForm = 'short'): string | null {
    if (!isFreePrice(credits)) return null;
    return form === 'box' && type === 'need' ? t(FREE_PRICE_WORDS.needBox) : t(FREE_PRICE_WORDS.short);
}

/**
 * The detail page's price-box label over a free Need ("Price"); null for any other listing, whose label stays what the
 * page wrote ("Asking price" over an Offer, "Willing to pay" over a priced Need).
 */
export function freePriceLabel(credits: unknown, type: string | null | undefined): string | null {
    return isFreePrice(credits) && type === 'need' ? t(FREE_PRICE_WORDS.needLabel) : null;
}

/**
 * A priced line as one string, where a card writes it in words ("20 Beans /hr"): `priced` is that line when there is a
 * price, and this returns "Free" instead when there is not. For a share line or a screen reader's label.
 */
export function priceOrFree(credits: unknown, type: string | null | undefined, priced: string, form: FreePriceForm = 'short'): string {
    return freePriceWords(credits, type, form) ?? priced;
}
