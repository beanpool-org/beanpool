/**
 * The seller's fields for a price for each one (slice P4 of scratch/fable-design/DESIGN-per-item-price-fable.md §2.4, §2.5):
 * the three boxes (the price for one, how many, the price for all of them), the one live line under the last, the fee line,
 * the Total -> Each carry-over, what a create and an edit send, and the sentence for each refusal. One copy, read by the
 * phone's create and edit forms and the web's, so both say and send the same; the sentences are core per-item.ts's
 * (`perItemLines`), the node's rules are the same functions (`itemColumnsRefusal`, `isItemCount`), so a form never lets
 * through what the node would refuse, and never refuses what it would take.
 *
 * Pure: no I/O, no Node built-ins (the barrel is bundled for the phone). The boxes are text, read as a member types them
 * (core parseHundredths: the language's decimal mark, at most two decimals, never a float).
 */
import { lexAmount } from './amount-input.js';
import { formatHundredths, parseHundredths, type Hundredths } from './hundredths.js';
import type { UiLang } from './words.js';
import {
    ITEM_COUNT_MAX, LOT_UNITS_MIN, itemColumnsRefusal, itemsAmount, perItemLines, perItemOffered, perItemRefusalText,
    type ItemLot, type PerItemRefusalOf,
} from './per-item.js';

/**
 * The price units a create or edit form offers, in the order the unit button cycles and the web's list reads: Total, then
 * Each (right after Total, §2.4), then per hour, day, week and month. Each only on an Offer, and only where the node's features
 * answer says it takes up an Offer priced for each one (`perItem`, absent until every slice is merged): until then the list is
 * the five it always was. Pass `keep` (an edit of a listing already priced each) so the unit it has is never taken away.
 */
export function priceUnitsOffered(
    features: { perItem?: unknown } | null | undefined, type: string | null | undefined, keep?: string | null,
): readonly ('fixed' | 'each' | 'hourly' | 'daily' | 'weekly' | 'monthly')[] {
    const each = type === 'offer' && (perItemOffered(features) || keep === 'each');
    return each ? ['fixed', 'each', 'hourly', 'daily', 'weekly', 'monthly'] : ['fixed', 'hourly', 'daily', 'weekly', 'monthly'];
}

/** The three boxes as a member typed them. */
export interface PerItemFormText {
    /** The price for one (the form's Price box, which on Each reads "PRICE FOR ONE"). */
    price: string;
    /** How many the seller has (on an edit: has left). */
    count: string;
    /** The price for all of them, or empty for none. */
    lot: string;
}

export const EMPTY_PER_ITEM_TEXT: Readonly<PerItemFormText> = Object.freeze({ price: '', count: '', lot: '' });

/** The boxes read: null where a box is empty or is not a figure of its kind. */
export interface PerItemRead {
    price_c: Hundredths | null;
    /** A whole number of items, 0 to 9,999, or null (empty, a fraction, a sign, a letter). */
    count: number | null;
    /** The price for all, whole hundredths above 0, or null (empty or not one). */
    lot_c: Hundredths | null;
    /** The price-for-all box holds something, and it is not a Beans figure above 0. */
    lotBad: boolean;
}

/**
 * A count as typed: a whole number, 0 to 9,999 ("2.5", "-3", "+3", "1e3", "" are none). Read in `lang` (the device's language
 * when absent) exactly as the amount boxes beside it are, by core's lexAmount: the language's own digits (an Arabic, Persian,
 * Hindi, Bengali, Tamil, Malayalam number pad, or the full-width digits a Japanese, Korean or Chinese keyboard types) read as
 * 0-9, two number systems in one figure refused, a figure that could mean two never guessed. No decimals are allowed.
 */
export function readCount(text: string, lang?: UiLang): number | null {
    if (/^\s*\+/.test(text)) return null;
    const lexed = lexAmount(text, lang, 0);
    if (!lexed.ok || lexed.negative || lexed.fraction !== '') return null;
    const whole = lexed.whole.replace(/^0+(?=\d)/, '');
    if (!/^\d{1,4}$/.test(whole)) return null;
    const n = Number(whole);
    return n <= ITEM_COUNT_MAX ? n : null;
}

/** The three boxes, read. */
export function readPerItemForm(text: PerItemFormText, lang?: UiLang): PerItemRead {
    const price = parseHundredths(text.price, lang);
    const lot = text.lot.trim() === '' ? null : parseHundredths(text.lot, lang);
    return {
        price_c: price.ok ? price.value : null,
        count: readCount(text.count, lang),
        lot_c: lot && lot.ok && lot.value > 0 ? lot.value : null,
        lotBad: lot !== null && !(lot.ok && lot.value > 0),
    };
}

/** A price for one that is Free (typed 0): such a listing has no price for all of them, and its box is not shown. */
export function perItemIsFree(text: PerItemFormText, lang?: UiLang): boolean {
    return readPerItemForm(text, lang).price_c === 0;
}

/** An amount as a member types it again: the language's figure without the thousands marks English groups with. */
export function amountAsTyped(c: unknown, lang?: UiLang): string {
    return typeof c === 'number' && Number.isInteger(c) ? formatHundredths(c, lang).replace(/,(?=\d{3}(?!\d))/g, '') : '';
}

/** What `count` of them come to one by one, when both boxes are good; null otherwise. */
function oneByOne(r: PerItemRead): Hundredths | null {
    return r.price_c !== null && r.price_c > 0 && r.count !== null && r.count >= LOT_UNITS_MIN ? itemsAmount(r.price_c, r.count) : null;
}

/** The one live line under the price-for-all box (§2.4). Null where there is none to show. */
export type LotHint = { kind: 'empty' | 'good' | 'notLess'; text: string };

/**
 * empty: "Leave this empty to sell them one by one only."; good: "All 20 for 5,500 Beans. One by one they come to 6,000.";
 * not less: "One by one, 20 come to 6,000 Beans. A price for all of them has to be less." Hidden (null) when the count is 1
 * or not yet a count, the price is Free or not yet a price, or the box holds something that is not a figure.
 */
export function perItemLotHint(text: PerItemFormText, lang?: UiLang): LotHint | null {
    if (text.lot.trim() === '') return { kind: 'empty', text: perItemLines.lotEmpty() };
    const r = readPerItemForm(text, lang);
    const total = oneByOne(r);
    if (total === null || r.lot_c === null) return null;
    return r.lot_c < total
        ? { kind: 'good', text: perItemLines.lotGood(r.count!, r.lot_c, r.price_c!) }
        : { kind: 'notLess', text: perItemLines.lotNotLess(r.count!, r.price_c!) };
}

/**
 * "1.5% goes to the community. You receive 295.50 Beans for each one, or 5,417.50 Beans for all of them." The part for all
 * of them is there only while the price for all is a good one. Null until the price for one is above 0.
 */
export function perItemFeeLine(text: PerItemFormText, lang?: UiLang): string | null {
    const r = readPerItemForm(text, lang);
    if (r.price_c === null || r.price_c <= 0) return null;
    const total = oneByOne(r);
    const lot = total !== null && r.lot_c !== null && r.lot_c < total ? r.lot_c : null;
    return perItemLines.feeLine(r.price_c, lot);
}

/**
 * Damo's way in (§2.4): a seller who typed a figure as the Total and then picks Each sees it move to "Or all of them for",
 * with the price for one empty and in focus, so "the lot, or ___ each" is how it feels. Only a figure above 0 moves, and only
 * into an empty price-for-all box; a Free price, an empty one, a figure that is not an amount, or a box already filled stays.
 */
export function carryTotalToEach(text: PerItemFormText, lang?: UiLang): PerItemFormText {
    if (text.lot.trim() !== '') return text;
    const price = parseHundredths(text.price, lang);
    if (!price.ok || price.value <= 0) return text;
    return { ...text, price: '', lot: text.price.trim() };
}

/** Which box a refusal is about, to mark it. */
export type PerItemField = 'price' | 'count' | 'lot';

export interface PerItemFormRefusal {
    field: PerItemField;
    /** The core code (the same the node answers with). */
    code: PerItemRefusalOf['code'];
    /** The sentence, in the member's language. */
    text: string;
}

function refuse(field: PerItemField, r: PerItemRefusalOf): PerItemFormRefusal {
    return { field, code: r.code, text: perItemRefusalText(r) };
}

/**
 * Why the three boxes can't be sent yet, by the node's own rules, or null. `was` is the count the screen read when an
 * edit opened (null on a create, and on an edit of a listing that was not priced for each one): a count left as it was
 * is never refused, even 0 (all taken for now); a changed count must be 1 or more ("To stop selling, pause or remove the
 * listing."). The price for one itself is the form's own box and its own checks; a Free price has no price for all of them.
 */
export function perItemFormRefusal(text: PerItemFormText, was: number | null = null, lang?: UiLang): PerItemFormRefusal | null {
    const r = readPerItemForm(text, lang);
    if (r.count === null) return refuse('count', { code: 'units_refused' });
    if (r.count === 0 && r.count !== was) return refuse('count', { code: was !== null ? 'units_zero' : 'units_refused' });
    if (text.lot.trim() === '' || r.price_c === 0) return null;
    if (r.lotBad || r.lot_c === null) return refuse('lot', { code: 'lot_price_refused' });
    if (r.count < LOT_UNITS_MIN) return refuse('lot', { code: 'lot_needs_two' });
    const total = r.price_c !== null ? itemsAmount(r.price_c, r.count) : null;
    return total !== null && r.lot_c >= total ? refuse('lot', { code: 'lot_not_less', count: r.count, total_c: total }) : null;
}

/** What a create sends for a listing priced for each one (merge into the body beside `price_c`). */
export interface PerItemCreateFields {
    priceType: 'each';
    unitsLeft: number;
    /** Absent when there is no price for all of them. */
    lot?: { price_c: Hundredths };
}

/** The create's fields, or the first refusal. The price for one (`price_c`) is read by the form beside it. */
export function perItemCreateFields(text: PerItemFormText, lang?: UiLang): { ok: true; fields: PerItemCreateFields } | { ok: false; refusal: PerItemFormRefusal } {
    const refusal = perItemFormRefusal(text, null, lang);
    if (refusal) return { ok: false, refusal };
    const r = readPerItemForm(text, lang);
    const sendsLot = r.price_c !== 0 && r.lot_c !== null;
    return { ok: true, fields: { priceType: 'each', unitsLeft: r.count!, ...(sendsLot ? { lot: { price_c: r.lot_c! } } : {}) } };
}

/** What the edit form shows of a listing as stored: its three boxes, and whether the stored price for all is set for another number. */
export interface PerItemStored {
    /** The listing is priced for each one now (an edit of a Total listing starts empty). */
    wasEach: boolean;
    unitsLeft: number | null;
    lot: ItemLot | null;
}

/**
 * The edit's opening count and price-for-all boxes (the price for one is the form's own box), and the stored price for all
 * when it is not showing (set for another number than are left): its box starts empty and the form says why.
 */
export function perItemEditStart(stored: PerItemStored | null | undefined, lang?: UiLang): { count: string; lot: string; lotForOther: ItemLot | null } {
    if (!stored?.wasEach || typeof stored.unitsLeft !== 'number') return { count: '', lot: '', lotForOther: null };
    const lot = stored.lot;
    const showing = !!lot && lot.units === stored.unitsLeft;
    return { count: String(stored.unitsLeft), lot: showing ? amountAsTyped(lot.price_c, lang) : '', lotForOther: lot && !showing ? lot : null };
}

/** "Your price for all of them was for 20. There are 17 left, so it is not showing. Set a price for the 17 left, or leave this empty." */
export function perItemLotForOtherLine(lot: ItemLot, unitsLeft: number): string {
    return perItemLines.lotForOtherCount(lot.units, unitsLeft);
}

/** The edit's fields: the unit, the count, the count the screen read, and the price for all of them. */
export interface PerItemEditFields {
    priceType: 'each';
    unitsLeft: number;
    /** The count the screen read: the node writes the count only if the row still holds it (`units_changed` otherwise). Absent for a listing made Each by this edit. */
    unitsLeftWas?: number;
    /**
     * A price for all of them: `{ price_c }` sets it (for the count saved with it), `null` clears it, absent keeps what is
     * stored. Absent is how an untouched box that showed nothing (a price for another number, kept in case that deal is
     * cancelled and the number comes back) is left alone.
     */
    lot?: { price_c: Hundredths } | null;
}

/**
 * After the node answers `units_changed` (a take-up landed while the seller edited): the stored count the save is made
 * against is the count now, the count box shows it, and the price-for-all box is rebuilt for it unless the seller touched it
 * (§2.5). A box they did not touch showed the stored price because it was for the old count; for the count now it is empty
 * with the "was for 20" line, as an edit opened now would be, else the save would send it back and the node would bind it
 * to the 17 (a price sent at its stored figure while set for another number is new there) though the seller never set it
 * for 17. A box they touched stays as typed: the node binds it to the count seen.
 */
export function perItemAfterUnitsChanged(
    storedLot: ItemLot | null, unitsLeft: number, lotText: string, lotTouched: boolean, lang?: UiLang,
): { stored: { unitsLeft: number; lot: ItemLot | null }; count: string; lot: string } {
    const start = perItemEditStart({ wasEach: true, unitsLeft, lot: storedLot }, lang);
    return { stored: { unitsLeft, lot: storedLot }, count: start.count, lot: lotTouched ? lotText : start.lot };
}

/**
 * The edit's fields, or the first refusal. `touched` is whether the seller changed the price-for-all box since the form
 * opened: an empty box they left alone keeps what is stored, one they emptied clears it (a stored price for another
 * number is never cleared by a title edit, so it is back if the deal that took one is cancelled). One exception, for a
 * stored price for another number that the price for one now leaves not less than its own number one by one (the node's
 * `lot_not_less` on the columns it would keep): it is cleared, since it can never be on offer at this price, and the node
 * must not refuse a box the seller can't see.
 */
export function perItemEditFields(
    text: PerItemFormText, stored: PerItemStored | null | undefined, lotTouched: boolean, lang?: UiLang,
): { ok: true; fields: PerItemEditFields } | { ok: false; refusal: PerItemFormRefusal } {
    const was = stored?.wasEach && typeof stored.unitsLeft === 'number' ? stored.unitsLeft : null;
    const refusal = perItemFormRefusal(text, was, lang);
    if (refusal) return { ok: false, refusal };
    const r = readPerItemForm(text, lang);
    const typedLot = text.lot.trim() !== '' && r.price_c !== 0 && r.lot_c !== null;
    const emptied = text.lot.trim() === '' || r.price_c === 0;
    // A stored price for all, kept by an empty untouched box, is checked against the price for one now by the node's own
    // rule (itemColumnsRefusal over the columns the node would keep): refused there, it is cleared here.
    const staleLot = !!stored?.lot && r.price_c !== null && itemColumnsRefusal(r.price_c, {
        units_left: r.count!, lot_price_c: stored.lot.price_c, lot_units: stored.lot.units,
    }) !== null;
    const lot: PerItemEditFields['lot'] = typedLot ? { price_c: r.lot_c! } : emptied && (lotTouched || r.price_c === 0 || staleLot) && stored?.lot ? null : undefined;
    return {
        ok: true,
        fields: { priceType: 'each', unitsLeft: r.count!, ...(was !== null ? { unitsLeftWas: was } : {}), ...(lot !== undefined ? { lot } : {}) },
    };
}

/**
 * How many are held for buyers in the deals under way on a listing priced for each one: their counts added (`hours` is how
 * many on a per-item deal, a whole number). The count on the listing does not include them; the edit says so (§2.5).
 */
export function itemsHeldIn(rows: readonly object[]): number {
    let n = 0;
    for (const row of rows) {
        const hours = (row as { hours?: unknown }).hours;
        if (typeof hours === 'number' && Number.isInteger(hours) && hours > 0) n += hours;
    }
    return n;
}

/** The note under the count on an edit, or null: "3 are held for buyers now. They are not counted here." */
export function perItemHeldNote(held: number): string | null {
    return held > 0 ? perItemLines.heldNotCounted(held) : null;
}
