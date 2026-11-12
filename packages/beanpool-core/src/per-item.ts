/**
 * A price for each one, a count, and a price for all of them (scratch/fable-design/DESIGN-per-item-price-fable.md; Marty took
 * all six of its recommendations, 12 Nov 2026). An Offer whose price unit is **Each** holds the price for one (`price_c`), how
 * many can be taken up now (`unitsLeft`), and optionally a price for all of them (`lot`), which is for an exact number and is
 * on offer only while exactly that many are left ({@link lotOffered}). Every other listing has none of the three and reads as
 * it always did.
 *
 * One copy, read by the node and both apps: the rules a listing's fields are held to on a create and an edit, the amounts a
 * deal comes to, and every sentence a member reads about it (§2), marked once here so the node writes the English
 * (`wordsFor('en')`) and the apps the member's language from the same key. A count is not money: it never touches a balance.
 *
 * Pure: no I/O, no Node built-ins (the barrel is bundled for the phone).
 */
import { t, tn, word, wordn, type Words } from './words.js';
import { dealAmountFor, feeOf, formatHundredths, isHundredths, type Hundredths } from './hundredths.js';
import { FREE_PRICE_WORDS } from './listing-price.js';

/** The price unit (posts.price_type) of a listing priced for each one. */
export const EACH = 'each' as const;
/** The most items one listing may hold, and one deal may be for. */
export const ITEM_COUNT_MAX = 9999;
/** The fewest items a price for all of them may be for. */
export const LOT_UNITS_MIN = 2;

/** Which way a per-item deal was taken up (marketplace_transactions.item_option): a number of them, or all of them. */
export type ItemOption = 'each' | 'lot';
export const ITEM_OPTIONS: readonly ItemOption[] = Object.freeze(['each', 'lot']);

/** A price for all of them: the exact number it is for, and its price in whole hundredths. */
export interface ItemLot {
    units: number;
    price_c: Hundredths;
}

/** What a listing says of its items, as the node sends it on a post (`unitsLeft`, `lot`) beside its price. */
export interface PerItemListing {
    priceType?: string | null;
    price_c: Hundredths;
    unitsLeft?: number | null;
    lot?: ItemLot | null;
}

/** The three columns as a listing stores them: all NULL on every listing not priced for each one. */
export interface ItemColumns {
    units_left: number | null;
    lot_price_c: Hundredths | null;
    lot_units: number | null;
}

export const NOT_PER_ITEM: Readonly<ItemColumns> = Object.freeze({ units_left: null, lot_price_c: null, lot_units: null });

/** Whether a listing is priced for each one. */
export function isPerItem(p: { priceType?: unknown } | null | undefined): boolean {
    return p?.priceType === EACH;
}

/** A number of items a seller has or a buyer takes: a whole number from 1 to 9,999. "3", 2.5, 0, Infinity are not. */
export function isItemCount(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= ITEM_COUNT_MAX;
}

/** A stored count: a whole number from 0 (all taken for now) to 9,999. */
export function isUnitsLeft(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= ITEM_COUNT_MAX;
}

/**
 * Whether the price for all of them is on offer: a listing priced for each one, with a price for all set for exactly the
 * number left now (two or more). One taken singly and it is off; that deal cancelled and it is back (design D2).
 */
export function lotOffered(p: PerItemListing | null | undefined): boolean {
    if (!p || !isPerItem(p) || !p.lot || !isUnitsLeft(p.unitsLeft)) return false;
    return p.unitsLeft >= LOT_UNITS_MIN && p.lot.units === p.unitsLeft && isHundredths(p.lot.price_c) && p.lot.price_c > 0;
}

/** What `n` of them come to at `price_c` each, exactly (whole hundredths, never a fraction of an item). */
export function itemsAmount(price_c: Hundredths, n: number): Hundredths {
    return dealAmountFor(price_c, n);
}

/** What a buyer pays: `n` of them one by one, or the price for all while it is on offer. Null for a take-up that can't be. */
export function itemTotal(p: PerItemListing, choice: { option: 'each'; n: number } | { option: 'lot' }): Hundredths | null {
    if (!isPerItem(p) || !isHundredths(p.price_c) || p.price_c < 0 || !isUnitsLeft(p.unitsLeft)) return null;
    if (choice.option === 'lot') return lotOffered(p) ? p.lot!.price_c : null;
    return isItemCount(choice.n) && choice.n <= p.unitsLeft ? itemsAmount(p.price_c, choice.n) : null;
}

/** How much less the price for all is than the same number one by one, while it is on offer; null otherwise. */
export function lotSaving(p: PerItemListing): Hundredths | null {
    return lotOffered(p) ? itemsAmount(p.price_c, p.lot!.units) - p.lot!.price_c : null;
}

/** What the seller receives of a deal's amount: less the community's 1.5%, truncated once (feeOf), as the release pays it. */
export function sellerReceives(amount_c: Hundredths): Hundredths {
    return amount_c - feeOf(amount_c);
}

/** Why a create or an edit is refused, the code on the wire (each has its sentence in {@link perItemRefusalText}); `units_changed` is a 409. */
export const PER_ITEM_REFUSALS = Object.freeze(['each_offer_only', 'units_refused', 'units_zero', 'units_changed', 'lot_price_refused', 'lot_needs_two', 'lot_not_less'] as const);
export type PerItemRefusal = (typeof PER_ITEM_REFUSALS)[number];

export interface PerItemRefusalOf {
    code: PerItemRefusal;
    /** units_changed: how many are left now. lot_not_less: how many the price for all is for. */
    count?: number;
    /** lot_not_less: what that many come to one by one. */
    total_c?: Hundredths;
}

/**
 * A price for all of them as a create or an edit sends it: `{ price_c }` (whole hundredths, more than 0), or none (absent or
 * null). Anything else is refused, never rounded.
 */
export function lotPriceIn(raw: unknown): { ok: true; price_c: Hundredths | null } | { ok: false } {
    if (raw === undefined || raw === null) return { ok: true, price_c: null };
    const price_c = typeof raw === 'object' && !Array.isArray(raw) ? (raw as { price_c?: unknown }).price_c : undefined;
    return isHundredths(price_c) && price_c > 0 ? { ok: true, price_c } : { ok: false };
}

/**
 * The rules on a listing's three columns as they will be stored (design §3), on a create and an edit alike: a count from 0 to
 * 9,999; the two lot columns set together or not at all, the number at least 2, and the price less than that many one by one
 * (a free listing has no price for all). Null when they hold.
 */
export function itemColumnsRefusal(price_c: Hundredths, cols: ItemColumns): PerItemRefusalOf | null {
    if (!isUnitsLeft(cols.units_left)) return { code: 'units_refused' };
    if (cols.lot_price_c === null && cols.lot_units === null) return null;
    if (!isHundredths(cols.lot_price_c) || cols.lot_price_c <= 0) return { code: 'lot_price_refused' };
    if (!isUnitsLeft(cols.lot_units) || cols.lot_units < LOT_UNITS_MIN) return { code: 'lot_needs_two' };
    const total_c = itemsAmount(price_c, cols.lot_units);
    return cols.lot_price_c < total_c ? null : { code: 'lot_not_less', count: cols.lot_units, total_c };
}

/** Is the node's features answer offering Each (`perItem`)? Off until every slice is in: then the forms offer it (§6). */
export function perItemOffered(features: { perItem?: unknown } | null | undefined): boolean {
    return features?.perItem === true;
}

// ── The words (design §2) ───────────────────────────────────────────────────────────────────────────────────────
// Every sentence once, in the order the design lists them. A count goes through the plural form; a figure is written by
// formatHundredths. Translator notes: "each" is the price for one item; "left" how many can still be bought; "all" one
// price for every item together.

export const PER_ITEM_WORDS = {
    // §2.1 The card
    each: wordn('{n} Beans each', '{n} Beans each'),
    left: wordn('{n} left', '{n} left'),
    orAllFor: wordn('or all for {n}', 'or all for {n}'),
    allTakenForNow: word('All taken for now'),
    soldOut: word('Sold out'),
    eachShort: wordn('{n} 🫘 each', '{n} 🫘 each'),
    orAllForShort: wordn('or all for {n} 🫘', 'or all for {n} 🫘'),
    allShort: wordn('all {n} 🫘', 'all {n} 🫘'),
    leftChip: wordn('{n} LEFT', '{n} LEFT'),
    // §2.2 The item page, for a buyer
    orAllCountFor: wordn('or all {count} for {n} Beans', 'or all {count} for {n} Beans'),
    howMany: word('How many would you like?'),
    chooseHowMany: word('Choose how many'),
    allCountFor: wordn('All {count} for {n} Beans', 'All {count} for {n} Beans'),
    lessOneByOne: wordn('{n} less than one by one', '{n} less than one by one'),
    timesEquals: wordn('{count} × {price} = {n} Beans', '{count} × {price} = {n} Beans'),
    intoTrust: wordn('{n} Beans go into trust now. {name} receives {net} when you release them (1.5% goes to the community).',
        '{n} Beans go into trust now. {name} receives {net} when you release them (1.5% goes to the community).'),
    onlyLeft: wordn('Only {n} left now. Choose {n} or fewer.', 'Only {n} left now. Choose {n} or fewer.'),
    allTakenUp: word('They have all been taken up.'),
    lotGone: word('One has just been taken, so the price for all of them is off. You can still take what is left one by one.'),
    priceChanged: word('The price changed while you were looking. Check it and try again.'),
    wholeNumber: word('Choose a whole number, 1 or more.'),
    // §2.3 Both sides of the deal
    youTookUp: wordn('✅ You took up {count} on {date} · {n} Beans held in trust', '✅ You took up {count} on {date} · {n} Beans held in trust'),
    youTookUpAll: wordn('✅ You took up all {count} on {date} · {n} Beans held in trust', '✅ You took up all {count} on {date} · {n} Beans held in trust'),
    heldForBuyers: wordn('{n} held for buyers', '{n} held for buyers'),
    dealRow: wordn('{name} · {count} for {n} Beans held · since {date}', '{name} · {count} for {n} Beans held · since {date}'),
    dealRowAll: wordn('{name} · all {count} for {n} Beans held · since {date}', '{name} · all {count} for {n} Beans held · since {date}'),
    dealTitle: wordn('{n} × {title}', '{n} × {title}'),
    dealTitleAll: wordn('All {n} × {title}', 'All {n} × {title}'),
    pushTook: wordn('{name} took {count} of "{title}". {n} Beans are held in trust.', '{name} took {count} of "{title}". {n} Beans are held in trust.'),
    pushTookAll: wordn('{name} took all {count} of "{title}". {n} Beans are held in trust.', '{name} took all {count} of "{title}". {n} Beans are held in trust.'),
    releaseOtherCount: wordn('This deal is for {n}. To change the number, cancel it and take it up again.',
        'This deal is for {n}. To change the number, cancel it and take it up again.'),
    // §2.4 The seller, creating
    unitEach: word('Each', 'price unit'),
    priceForOne: word('PRICE FOR ONE'),
    howManyHave: word('HOW MANY DO YOU HAVE?'),
    orAllOfThemFor: word('OR ALL OF THEM FOR (OPTIONAL)'),
    lotEmpty: word('Leave this empty to sell them one by one only.'),
    lotGood: wordn('All {count} for {n} Beans. One by one they come to {total}.', 'All {count} for {n} Beans. One by one they come to {total}.'),
    lotNotLess: wordn('One by one, {count} come to {n} Beans. A price for all of them has to be less.',
        'One by one, {count} come to {n} Beans. A price for all of them has to be less.'),
    feeLine: wordn('1.5% goes to the community. You receive {n} Beans for each one.', '1.5% goes to the community. You receive {n} Beans for each one.'),
    feeLineLot: wordn('1.5% goes to the community. You receive {n} Beans for each one, or {all} Beans for all of them.',
        '1.5% goes to the community. You receive {n} Beans for each one, or {all} Beans for all of them.'),
    unitsRefused: word('Say how many you have: a whole number from 1 to 9,999.'),
    lotNeedsTwo: word('A price for all of them needs 2 or more.'),
    offerOnly: word('Only an Offer can be priced for each one.'),
    lotPriceRefused: word('A price for all of them must be a number of Beans above 0.'),
    // §2.5 The seller, editing
    howManyLeft: word('HOW MANY DO YOU HAVE LEFT?'),
    heldNotCounted: wordn('{n} is held for a buyer now. It is not counted here.', '{n} are held for buyers now. They are not counted here.'),
    lotForOtherCount: wordn(
        'Your price for all of them was for {was}. There is {n} left, so it is not showing. Set a price for the {n} left, or leave this empty.',
        'Your price for all of them was for {was}. There are {n} left, so it is not showing. Set a price for the {n} left, or leave this empty.'),
    unitsChanged: wordn('Someone took some while you were editing. There is {n} left now. Check the number and save again.',
        'Someone took some while you were editing. There are {n} left now. Check the number and save again.'),
    unitsZero: word('To stop selling, pause or remove the listing.'),
} as const;

const W = PER_ITEM_WORDS;
/** A figure in the words (formatHundredths), and the Beans it counts for the plural form. */
const fig = (c: Hundredths) => formatHundredths(c);
const beansOf = (c: Hundredths) => c / 100;

/** Every sentence of the design, by where it is read. Amounts are whole hundredths; names, titles and dates come formatted. */
export const perItemLines = {
    // §2.1
    each: (price_c: Hundredths) => tn(beansOf(price_c), W.each.one, W.each.other, { n: fig(price_c) }),
    left: (n: number) => tn(n, W.left.one, W.left.other),
    orAllFor: (price_c: Hundredths) => tn(beansOf(price_c), W.orAllFor.one, W.orAllFor.other, { n: fig(price_c) }),
    allTakenForNow: () => t(W.allTakenForNow),
    soldOut: () => t(W.soldOut),
    eachShort: (price_c: Hundredths) => tn(beansOf(price_c), W.eachShort.one, W.eachShort.other, { n: fig(price_c) }),
    orAllForShort: (price_c: Hundredths) => tn(beansOf(price_c), W.orAllForShort.one, W.orAllForShort.other, { n: fig(price_c) }),
    allShort: (price_c: Hundredths) => tn(beansOf(price_c), W.allShort.one, W.allShort.other, { n: fig(price_c) }),
    leftChip: (n: number) => tn(n, W.leftChip.one, W.leftChip.other),
    // §2.2
    orAllCountFor: (count: number, price_c: Hundredths) => tn(beansOf(price_c), W.orAllCountFor.one, W.orAllCountFor.other, { n: fig(price_c), count }),
    howMany: () => t(W.howMany),
    chooseHowMany: () => t(W.chooseHowMany),
    allCountFor: (count: number, price_c: Hundredths) => tn(beansOf(price_c), W.allCountFor.one, W.allCountFor.other, { n: fig(price_c), count }),
    lessOneByOne: (saving_c: Hundredths) => tn(beansOf(saving_c), W.lessOneByOne.one, W.lessOneByOne.other, { n: fig(saving_c) }),
    timesEquals: (count: number, price_c: Hundredths) => {
        const total = itemsAmount(price_c, count);
        return tn(beansOf(total), W.timesEquals.one, W.timesEquals.other, { n: fig(total), count, price: fig(price_c) });
    },
    intoTrust: (amount_c: Hundredths, name: string) =>
        tn(beansOf(amount_c), W.intoTrust.one, W.intoTrust.other, { n: fig(amount_c), name, net: fig(sellerReceives(amount_c)) }),
    onlyLeft: (n: number) => tn(n, W.onlyLeft.one, W.onlyLeft.other),
    allTakenUp: () => t(W.allTakenUp),
    lotGone: () => t(W.lotGone),
    priceChanged: () => t(W.priceChanged),
    wholeNumber: () => t(W.wholeNumber),
    // §2.3
    youTookUp: (option: ItemOption, count: number, date: string, amount_c: Hundredths) => (option === 'lot'
        ? tn(beansOf(amount_c), W.youTookUpAll.one, W.youTookUpAll.other, { n: fig(amount_c), count, date })
        : tn(beansOf(amount_c), W.youTookUp.one, W.youTookUp.other, { n: fig(amount_c), count, date })),
    heldForBuyers: (n: number) => tn(n, W.heldForBuyers.one, W.heldForBuyers.other),
    dealRow: (option: ItemOption, name: string, count: number, amount_c: Hundredths, date: string) => (option === 'lot'
        ? tn(beansOf(amount_c), W.dealRowAll.one, W.dealRowAll.other, { n: fig(amount_c), name, count, date })
        : tn(beansOf(amount_c), W.dealRow.one, W.dealRow.other, { n: fig(amount_c), name, count, date })),
    dealTitle: (option: ItemOption, count: number, title: string) => (option === 'lot'
        ? tn(count, W.dealTitleAll.one, W.dealTitleAll.other, { title })
        : tn(count, W.dealTitle.one, W.dealTitle.other, { title })),
    pushTook: (option: ItemOption, name: string, count: number, title: string, amount_c: Hundredths) => (option === 'lot'
        ? tn(beansOf(amount_c), W.pushTookAll.one, W.pushTookAll.other, { n: fig(amount_c), name, count, title })
        : tn(beansOf(amount_c), W.pushTook.one, W.pushTook.other, { n: fig(amount_c), name, count, title })),
    releaseOtherCount: (count: number) => tn(count, W.releaseOtherCount.one, W.releaseOtherCount.other),
    // §2.4
    unitEach: () => t(W.unitEach),
    priceForOne: () => t(W.priceForOne),
    howManyHave: () => t(W.howManyHave),
    orAllOfThemFor: () => t(W.orAllOfThemFor),
    lotEmpty: () => t(W.lotEmpty),
    lotGood: (count: number, lot_c: Hundredths, price_c: Hundredths) =>
        tn(beansOf(lot_c), W.lotGood.one, W.lotGood.other, { n: fig(lot_c), count, total: fig(itemsAmount(price_c, count)) }),
    lotNotLess: (count: number, price_c: Hundredths) => {
        const total = itemsAmount(price_c, count);
        return tn(beansOf(total), W.lotNotLess.one, W.lotNotLess.other, { n: fig(total), count });
    },
    feeLine: (price_c: Hundredths, lot_c: Hundredths | null) => (lot_c === null
        ? tn(beansOf(price_c), W.feeLine.one, W.feeLine.other, { n: fig(sellerReceives(price_c)) })
        : tn(beansOf(price_c), W.feeLineLot.one, W.feeLineLot.other, { n: fig(sellerReceives(price_c)), all: fig(sellerReceives(lot_c)) })),
    // §2.5
    howManyLeft: () => t(W.howManyLeft),
    heldNotCounted: (n: number) => tn(n, W.heldNotCounted.one, W.heldNotCounted.other),
    lotForOtherCount: (was: number, n: number) => tn(n, W.lotForOtherCount.one, W.lotForOtherCount.other, { was }),
    unitsZero: () => t(W.unitsZero),
};

/**
 * The card's line, three whole phrases joined (§2.1): "300 Beans each · 20 left · or all for 5,500", "Free · 20 left", and
 * "All taken for now" or "Sold out" in place of the count. Null for a listing not priced for each one.
 */
export function perItemLine(p: PerItemListing & { status?: string | null }): string | null {
    if (!isPerItem(p) || !isUnitsLeft(p.unitsLeft)) return null;
    const price = p.price_c > 0 ? perItemLines.each(p.price_c) : t(FREE_PRICE_WORDS.short);
    const stock = p.status === 'completed' ? perItemLines.soldOut() : p.unitsLeft === 0 ? perItemLines.allTakenForNow() : perItemLines.left(p.unitsLeft);
    return [price, stock, ...(lotOffered(p) ? [perItemLines.orAllFor(p.lot!.price_c)] : [])].join(' · ');
}

/**
 * A refusal's sentence, in the words given, its figures written in their language: the node writes the English
 * (`wordsFor('en')`, translated on the way out), the apps their member's language (the default).
 */
export function perItemRefusalText(r: PerItemRefusalOf, w?: Pick<Words, 't' | 'tn' | 'lang'>): string {
    const words = w ?? { t, tn };
    switch (r.code) {
        case 'each_offer_only': return words.t(W.offerOnly);
        case 'units_refused': return words.t(W.unitsRefused);
        case 'units_zero': return words.t(W.unitsZero);
        case 'units_changed': return words.tn(r.count ?? 0, W.unitsChanged.one, W.unitsChanged.other);
        case 'lot_price_refused': return words.t(W.lotPriceRefused);
        case 'lot_needs_two': return words.t(W.lotNeedsTwo);
        case 'lot_not_less': {
            const total = r.total_c ?? 0;
            return words.tn(beansOf(total), W.lotNotLess.one, W.lotNotLess.other, { n: formatHundredths(total, w?.lang), count: r.count ?? 0 });
        }
    }
}
