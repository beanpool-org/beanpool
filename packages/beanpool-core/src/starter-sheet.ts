/**
 * The "What could you offer?" sheet's rows (scratch/fable-design/DESIGN-cold-start-trades-fable.md §3.1 and §3.4, slice O2;
 * Marty, 4 Nov 2026: "All Fable's picks"). Slice O1 is the drafts and the rule that picks them (starter-offers.ts); this is
 * what the two apps draw from them, so the phone and the web show the same three rows with the same words and open the
 * composer with the same fields. Each app only draws the rows and hands one `opening` to its own composer door.
 *
 * - **A row is a way into the composer, never a post.** It carries words and a price the member can see; no photo (the
 *   composer asks for it, market-photos-mandatory), no place, no name. Post stays the member's tap.
 * - **The figure is the community's guide, or nothing.** A paid draft's Beans come from the community's own price guide
 *   (`starterFigureFor`) and only when the guide still prices that thing in the unit the draft's words are written for. A
 *   draft with no figure opens with the price left blank, so the composer asks for one: nothing is priced for the member
 *   by a guess, and a Total is never left standing for an hour or a night of someone's time.
 * - **Beans off (the global community):** the price column is hidden and every draft opens free, as that community's first
 *   post asks ("free or for swap").
 * - Words are `word()` keys; the apps show them through `t()`.
 */

import { beansPriceWords } from './event-copy.js';
import { beans as hundredthsOf } from './hundredths.js';
import { DEFAULT_PRICING_CATALOG, PRICING_CATEGORIES, pricingItemFor, type PricingCategory, type PricingGuideItem } from './pricing-catalog.js';
import { starterOffersFor, type StarterDraft } from './starter-offers.js';
import { t, word } from './words.js';

/** The sheet's own words, as a table (words:check reads a key). Shown through t(). */
export const STARTER_SHEET_WORDS = {
    title: word('What could you offer?'),
    note: word('Pick one. Every word is yours to change before it posts.'),
    other: word('Something else'),
    otherLabel: word('Something else. Opens a blank new Offer.'),
    rowLabel: word('{title}. Opens a new Offer with this filled in.'),
    rowLabelPriced: word('{title}, {price}. Opens a new Offer with this filled in.'),
} as const;

/** What a composer is opened with: the fields of a draft, in the member's language, ready for either app's composer. */
export interface StarterOpening {
    title: string;
    description: string;
    category: PricingCategory;
    /** Beans: 0 for a free draft (or where Beans are off); null for a paid draft with no figure, which the composer asks for. */
    credits: number | null;
    priceType: 'fixed' | 'hourly';
}

/** One row of the sheet. */
export interface StarterRow {
    /** `<category>.<position>` (a StarterDraft's id): stable across languages, for a row's key and test id. */
    id: string;
    emoji: string;
    /** The draft's title in the member's language. */
    title: string;
    /** "Free", "40 Beans", "40 Beans an hour"; null where Beans are off or the guide has no figure. */
    price: string | null;
    /** The whole row for a screen reader. */
    label: string;
    opening: StarterOpening;
}

/** The sheet as it is drawn: heading, note, the rows, and the "Something else" row at the end. */
export interface StarterSheet {
    title: string;
    note: string;
    rows: StarterRow[];
    other: { title: string; label: string };
}

const EMOJI = new Map<string, string>(PRICING_CATEGORIES.map((c) => [c.id, c.emoji]));

/**
 * The Beans the community's price guide gives for a paid draft, or null for none: a Free draft, a draft the guide has no
 * words for, an item the guide does not find, a price that is not a whole number of Beans (the composers open a whole
 * number), or an item the community prices in another unit than the draft's words were written for. An owner can re-unit
 * a guide item on their node ("Box Trailer" per week); the draft says "to hire for the day", so its figure would be wrong
 * and is dropped (the unit is compared with the unit of the same item in the guide the drafts were written against).
 */
export function starterFigureFor(items: readonly PricingGuideItem[] | null | undefined, draft: Pick<StarterDraft, 'category' | 'priceType' | 'guide'>): number | null {
    if (!Array.isArray(items) || draft.priceType === 'free' || !draft.guide) return null;
    const found = pricingItemFor(items, draft.category, draft.guide);
    const written = pricingItemFor(DEFAULT_PRICING_CATALOG, draft.category, draft.guide);
    if (!found || !written || (found.unit ?? '') !== (written.unit ?? '')) return null;
    return Number.isSafeInteger(found.priceBeans) && found.priceBeans > 0 ? found.priceBeans : null;
}

/** The fields the composer opens with for one draft (see the file's header for the price). */
export function starterOpeningFor(draft: StarterDraft, beans: boolean, figure: number | null): StarterOpening {
    const free = !beans || draft.priceType === 'free';
    return {
        title: t(draft.title),
        description: t(draft.description),
        category: draft.category,
        credits: free ? 0 : figure,
        priceType: !free && draft.priceType === 'hourly' ? 'hourly' : 'fixed',
    };
}

/**
 * The rows for a member who has starred `stars` (starterOffersFor picks them), with the community's price guide `guide`
 * when the app has it (null: no figures, and every paid draft opens with its price blank). `beans` is whether Beans show
 * in this community.
 */
export function starterRows(stars: readonly unknown[] | null | undefined, opts: { beans: boolean; guide?: readonly PricingGuideItem[] | null }): StarterRow[] {
    return starterOffersFor(stars).map((draft) => {
        const figure = opts.beans ? starterFigureFor(opts.guide, draft) : null;
        const title = t(draft.title);
        const price = !opts.beans ? null
            : draft.priceType === 'free' ? beansPriceWords({ price_c: 0, per: 'fixed' })
            // The guide's figure is whole Beans (a hint, never moved; starterFigureFor takes a safe integer only).
            : figure !== null ? beansPriceWords({ price_c: hundredthsOf(figure), per: draft.priceType === 'hourly' ? 'hourly' : 'fixed' })
            : null;
        return {
            id: draft.id,
            emoji: EMOJI.get(draft.category) ?? '🌱',
            title,
            price,
            label: price ? t(STARTER_SHEET_WORDS.rowLabelPriced, { title, price }) : t(STARTER_SHEET_WORDS.rowLabel, { title }),
            opening: starterOpeningFor(draft, opts.beans, figure),
        };
    });
}

/** The whole sheet, in the member's language. */
export function starterSheet(stars: readonly unknown[] | null | undefined, opts: { beans: boolean; guide?: readonly PricingGuideItem[] | null }): StarterSheet {
    return {
        title: t(STARTER_SHEET_WORDS.title),
        note: t(STARTER_SHEET_WORDS.note),
        rows: starterRows(stars, opts),
        other: { title: t(STARTER_SHEET_WORDS.other), label: t(STARTER_SHEET_WORDS.otherLabel) },
    };
}
