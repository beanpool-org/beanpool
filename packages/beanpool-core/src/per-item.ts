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
import { t, tn, upperCase, word, wordn, type Words } from './words.js';
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
    // A request on one, from an API caller or an app that asks first (§4.5): it is taken up in one step.
    eachAcceptOnly: word('This is taken up in one step: tap Accept Offer and choose how many.'),
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
    eachAcceptOnly: () => t(W.eachAcceptOnly),
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

// ── The cards (slice P2, design §2.1, §2.2) ───────────────────────────────────────────────────────────────────────
// Every card, row and price box reads a listing priced for each one through these two functions, so the phone, the web and
// the node's Home answer say the same thing in the same pieces.

/**
 * A listing as either app holds it, read as a per-item one: the web's post (`priceType`, `unitsLeft`, `lot`), the phone's cached
 * row (`price_type`, `units_left`, `lot_units`, `lot_price_c`) and a Home row (`priceType`, `unitsLeft`, `lot`). Null for a
 * listing that is not priced for each one, and for one the node sent no count for (an older node): such a listing reads as it
 * always did.
 */
export function perItemOf(p: unknown): (PerItemListing & { status?: string | null }) | null {
    const r = p as Record<string, unknown> | null | undefined;
    if (!r || typeof r !== 'object') return null;
    const priceType = (r.priceType ?? r.price_type) as string | undefined;
    if (priceType !== EACH) return null;
    const unitsLeft = r.unitsLeft ?? r.units_left;
    if (!isUnitsLeft(unitsLeft)) return null;
    const price_c = r.price_c;
    if (!isHundredths(price_c) || price_c < 0) return null;
    const rawLot = r.lot as { units?: unknown; price_c?: unknown } | null | undefined;
    const lot: ItemLot | null = rawLot && isUnitsLeft(rawLot.units) && isHundredths(rawLot.price_c)
        ? { units: rawLot.units, price_c: rawLot.price_c }
        : isUnitsLeft(r.lot_units) && isHundredths(r.lot_price_c) ? { units: r.lot_units, price_c: r.lot_price_c } : null;
    return { priceType, price_c, unitsLeft, lot, status: typeof r.status === 'string' ? r.status : null };
}

/** The Beans sign the card words are written with (🫘). */
export const BEANS_SIGN = '🫘';
/**
 * A line split at its Beans sign: the text before it and after it, so a card can draw its Beans picture there instead of the
 * emoji (an old Android has no glyph for it). A line without the sign comes back whole, as one piece.
 */
export function splitBeansSign(text: string): string[] {
    return text.split(BEANS_SIGN);
}

/** What a card, a row or the price box says of a listing priced for each one. */
export interface PerItemCard {
    /** The price for one, "300 🫘 each"; null when it is free (the card's own "Free" stands there). */
    price: string | null;
    /** How many can be taken: "20 left", "All taken for now" (none left, deals held) or "Sold out" (closed). */
    stock: string;
    /** True when none can be taken now: the stock is words, not a count. */
    stockOut: boolean;
    /** "or all for 5,500 🫘" while the price for all is on offer; null otherwise. */
    orAll: string | null;
    /** The same for the grid's pill and the compact row's end: "all 5,500 🫘". */
    allShort: string | null;
    /** The grid's one chip: "20 LEFT", or the stock in capitals. */
    chip: string;
    /** The one line under the title: "20 left · or all for 5,500 🫘". */
    line: string;
    /** The item page's price box: "or all 20 for 5,500 Beans". */
    boxLot: string | null;
    /** The whole card in words, for a screen reader: "300 Beans each · 20 left · or all for 5,500". */
    label: string;
}

/** The card's pieces for a listing priced for each one (design §2.1); null for any other, which reads as it always did. */
export function perItemCard(source: unknown): PerItemCard | null {
    const p = perItemOf(source);
    if (!p || !isUnitsLeft(p.unitsLeft)) return null;
    const closed = p.status === 'completed';
    const stockOut = closed || p.unitsLeft === 0;
    const stock = closed ? perItemLines.soldOut() : stockOut ? perItemLines.allTakenForNow() : perItemLines.left(p.unitsLeft);
    const offered = lotOffered(p);
    const orAll = offered ? perItemLines.orAllForShort(p.lot!.price_c) : null;
    return {
        price: p.price_c > 0 ? perItemLines.eachShort(p.price_c) : null,
        stock,
        stockOut,
        orAll,
        allShort: offered ? perItemLines.allShort(p.lot!.price_c) : null,
        chip: stockOut ? upperCase(stock) : perItemLines.leftChip(p.unitsLeft),
        line: [stock, ...(orAll ? [orAll] : [])].join(' · '),
        boxLot: offered ? perItemLines.orAllCountFor(p.lot!.units, p.lot!.price_c) : null,
        label: perItemLine(p) ?? stock,
    };
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

// ── The take-up (slice P1, design §4.1, §4.4, §4.5, §5) ──────────────────────────────────────────────────────────
// A listing priced for each one is taken up in one step, for a number of them or all of them: the Beans for exactly that go
// into trust and the count drops in the same write (the node's engine/per-item.ts reserveUnits). The deal row alone then
// says what it is: `hours` how many, `item_option` which way, `amount_c` what is held. The apps (P3) ask the same two
// questions of the same listing before they send, so they say what the node will say.

/**
 * Why a take-up, a request or a release on a listing priced for each one is refused: the code on the wire, each with its
 * sentence in {@link itemTakeUpRefusalText}. `count_refused` and `deal_count_fixed` are a 400; the rest are a 409, the
 * listing having moved on since the buyer's screen read it (`units_gone` with how many are left now).
 */
export const ITEM_TAKE_UP_REFUSALS = Object.freeze(['count_refused', 'price_changed', 'units_gone', 'lot_gone', 'each_accept_only', 'deal_count_fixed'] as const);
export type ItemTakeUpRefusal = (typeof ITEM_TAKE_UP_REFUSALS)[number];

export interface ItemTakeUpRefusalOf {
    code: ItemTakeUpRefusal;
    /** units_gone: how many are left now (0: all taken). deal_count_fixed: how many the deal is for. */
    count?: number;
}

/**
 * A take-up as the buyer's app sends it (design §3, "On the wire"), raw: how many (`hours` on the wire), which way
 * (`itemOption`), and the total its screen showed (`expect_c`, whole hundredths).
 */
export interface ItemTakeUpIn {
    n?: unknown;
    option?: unknown;
    expect_c?: unknown;
}

/** A take-up the rules let through: which way, how many, and the Beans that go into trust, whole hundredths. */
export interface ItemTakeUp {
    option: ItemOption;
    n: number;
    amount_c: Hundredths;
}

/**
 * What a take-up of a listing priced for each one comes to, from the listing as stored, or why it is refused before anything
 * is held (design §4.1). The way must be 'each' or 'lot' and the total the buyer saw must be given: an app from before
 * sends neither, and is refused `price_changed`, so it can never take one up by accident. How many is a whole number from 1
 * to 9,999, never rounded (`count_refused`). The amount is that many at the price for one, or the price for all as set (none
 * set: `lot_gone`), and it must be exactly the total the buyer saw (`price_changed`): nobody pays a figure they did not see.
 * Whether that many are still there is {@link itemStockRefusal}'s question.
 */
export function itemTakeUpOf(p: PerItemListing, take: ItemTakeUpIn): { ok: true; take: ItemTakeUp } | { ok: false; refusal: ItemTakeUpRefusalOf } {
    const option = take.option;
    if ((option !== 'each' && option !== 'lot') || take.expect_c === undefined || take.expect_c === null) return { ok: false, refusal: { code: 'price_changed' } };
    if (!isItemCount(take.n)) return { ok: false, refusal: { code: 'count_refused' } };
    if (!isPerItem(p) || !isHundredths(p.price_c) || p.price_c < 0) return { ok: false, refusal: { code: 'price_changed' } };
    let amount_c: Hundredths;
    if (option === 'lot') {
        if (!p.lot || !isHundredths(p.lot.price_c)) return { ok: false, refusal: { code: 'lot_gone' } };
        amount_c = p.lot.price_c;
    } else {
        amount_c = itemsAmount(p.price_c, take.n);
    }
    if (take.expect_c !== amount_c) return { ok: false, refusal: { code: 'price_changed' } };
    return { ok: true, take: { option, n: take.n, amount_c } };
}

/**
 * Whether what a take-up asks for is still there, from the listing as stored (design §4.1, §5), or why not: none left,
 * `units_gone` with 0 ("They have all been taken up."); fewer than asked, `units_gone` with how many there are; the price for
 * all no longer on offer, or on offer for another number than the buyer saw, `lot_gone`. Null when it is there. The node
 * asks it once before the hold, as a plain refusal; its guarded write asks again inside the hold and is the authority.
 */
export function itemStockRefusal(p: PerItemListing, take: Pick<ItemTakeUp, 'option' | 'n'>): ItemTakeUpRefusalOf | null {
    const left = isUnitsLeft(p.unitsLeft) ? p.unitsLeft : 0;
    if (left === 0) return { code: 'units_gone', count: 0 };
    if (take.option === 'lot') return lotOffered(p) && p.lot!.units === take.n ? null : { code: 'lot_gone' };
    return take.n <= left ? null : { code: 'units_gone', count: left };
}

/**
 * A take-up refusal's sentence (design §2.2, §2.3), in the words given: the node writes the English (`wordsFor('en')`,
 * translated on the way out), the apps their member's language (the default).
 */
export function itemTakeUpRefusalText(r: ItemTakeUpRefusalOf, w?: Pick<Words, 't' | 'tn'>): string {
    const words = w ?? { t, tn };
    switch (r.code) {
        case 'count_refused': return words.t(W.wholeNumber);
        case 'price_changed': return words.t(W.priceChanged);
        case 'units_gone': return r.count ? words.tn(r.count, W.onlyLeft.one, W.onlyLeft.other) : words.t(W.allTakenUp);
        case 'lot_gone': return words.t(W.lotGone);
        case 'each_accept_only': return words.t(W.eachAcceptOnly);
        case 'deal_count_fixed': return words.tn(r.count ?? 0, W.releaseOtherCount.one, W.releaseOtherCount.other);
    }
}
