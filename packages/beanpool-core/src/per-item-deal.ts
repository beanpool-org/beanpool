/**
 * The buyer's take-up box and both sides' deal lines for an Offer priced for each one (slice P3 of
 * scratch/fable-design/DESIGN-per-item-price-fable.md §2.2, §2.3). One copy, read by the phone's item page, Your deals and
 * chat, and the web's: the box says and sends the same on both, and a deal says how many it is for in the same words. Every
 * sentence is core per-item.ts's (`perItemLines`); the amount the box shows and sends is `itemTotal`'s, the one function the
 * node's take-up (itemTakeUpOf) works the deal's Beans out with, so the total on the screen is the total the node holds.
 *
 * Pure: no I/O, no Node built-ins (the barrel is bundled for the phone).
 */
import { t } from './words.js';
import { isHundredths, type Hundredths } from './hundredths.js';
import { FREE_PRICE_WORDS } from './listing-price.js';
import {
    ITEM_TAKE_UP_REFUSALS, isItemCount, itemTakeUpRefusalText, itemTotal, lotOffered, lotSaving, perItemCard, perItemLines,
    perItemOf, type ItemOption, type ItemTakeUpRefusal,
} from './per-item.js';
import { itemsHeldIn, readCount } from './per-item-form.js';
import type { UiLang } from './words.js';

// ── The box (§2.2) ───────────────────────────────────────────────────────────────────────────────────────────────

/** What the buyer has chosen in the box: a way, and the count as typed or stepped (the stepper's middle is a box). */
export interface ItemBoxState {
    option: ItemOption;
    count: string;
}

/** The box as it opens: one of them. */
export const ITEM_BOX_START: Readonly<ItemBoxState> = Object.freeze({ option: 'each', count: '1' });

/** What Confirm sends, beside `postId` and `buyerPublicKey` (design §3, "On the wire"): `expect_c` is the total shown. */
export interface ItemTakeUpSend {
    hours: number;
    itemOption: ItemOption;
    expect_c: Hundredths;
}

/** The box as drawn: every line, the stepper's bounds, and what Confirm sends. */
export interface ItemTakeUpBox {
    /** "How many would you like?" */
    title: string;
    /** "Choose how many" */
    chooseLabel: string;
    /** Beside the stepper: "300 Beans each · 20 left" ("Free · 20 left"). */
    eachLine: string;
    /** How many are left now: the stepper's top (0: none can be taken). */
    max: number;
    /** The way chosen, as it counts: all of them whenever the count is the number the price for all is for (§2.2). */
    option: ItemOption;
    /** The count the stepper shows: what was typed, or all of them. */
    count: string;
    /** The second choice, only while the price for all is on offer: "All 20 for 5,500 Beans", "500 less than one by one". */
    lot: { label: string; saving: string | null } | null;
    /** "3 × 300 = 900 Beans" or "All 20 for 5,500 Beans"; null while the count is not one, and on a free listing. */
    total: string | null;
    /** "900 Beans go into trust now. Rob receives 886.50 when you release them (1.5% goes to the community)." Null as `total`. */
    trust: string | null;
    /** Why Confirm can't go yet, in the box: not a whole number, more than are left, none left. Null when it can. */
    refusal: string | null;
    /** The stepper's two buttons: `-` stops at 1, `+` at what is left. */
    canLess: boolean;
    canMore: boolean;
    /** What Confirm sends; null while it can't be sent. */
    send: ItemTakeUpSend | null;
}

/** The count the box stands at, and the way it counts as: the price for all whenever the count is its number (§2.2). */
function chosenIn(source: unknown, state: ItemBoxState, lang?: UiLang): { option: ItemOption; n: number | null } {
    const p = perItemOf(source);
    const lot = p && lotOffered(p) ? p.lot! : null;
    if (lot && state.option === 'lot') return { option: 'lot', n: lot.units };
    const n = readCount(state.count, lang);
    // Nobody pays 6,000 where 5,500 is on offer: stepping or typing up to all of them while the price for all shows is it.
    if (lot && n === lot.units) return { option: 'lot', n };
    return { option: 'each', n };
}

/**
 * The box for a listing priced for each one, as the state chosen reads (§2.2); null for any other listing, which keeps its
 * own confirm. `sellerName` is who receives the Beans when they are released.
 */
export function itemTakeUpBox(source: unknown, state: ItemBoxState, sellerName: string, lang?: UiLang): ItemTakeUpBox | null {
    const p = perItemOf(source);
    if (!p || typeof p.unitsLeft !== 'number') return null;
    const max = p.status === 'completed' ? 0 : p.unitsLeft;
    const offered = lotOffered(p);
    const lot = offered ? p.lot! : null;
    const { option, n } = chosenIn(source, state, lang);
    const price = p.price_c > 0 ? perItemLines.each(p.price_c) : t(FREE_PRICE_WORDS.short);
    const stock = max === 0 ? perItemLines.allTakenForNow() : perItemLines.left(max);
    const refusal = max === 0 ? perItemLines.allTakenUp()
        : !isItemCount(n) ? perItemLines.wholeNumber()
        : n > max ? perItemLines.onlyLeft(max)
        : null;
    const amount_c = refusal === null && n !== null
        ? itemTotal(p, option === 'lot' ? { option: 'lot' } : { option: 'each', n })
        : null;
    const free = p.price_c === 0;
    const total = amount_c === null || free ? null
        : option === 'lot' ? perItemLines.allCountFor(lot!.units, lot!.price_c)
        : perItemLines.timesEquals(n!, p.price_c);
    const saving = lot ? lotSaving(p) : null;
    return {
        title: perItemLines.howMany(),
        chooseLabel: perItemLines.chooseHowMany(),
        eachLine: [price, stock].join(' · '),
        max,
        option,
        count: option === 'lot' && lot ? String(lot.units) : state.count,
        lot: lot ? { label: perItemLines.allCountFor(lot.units, lot.price_c), saving: saving !== null && saving > 0 ? perItemLines.lessOneByOne(saving) : null } : null,
        total,
        trust: total !== null && amount_c !== null ? perItemLines.intoTrust(amount_c, sellerName) : null,
        refusal,
        canLess: max > 0 && n !== null && n > 1,
        canMore: max > 0 && (n === null || n < max),
        send: amount_c === null || n === null ? null : { hours: n, itemOption: option, expect_c: amount_c },
    };
}

/**
 * The stepper (§2.2): one more or one fewer, whole numbers from 1 to what is left. A count that isn't one starts again at 1.
 * Stepping up to all of them while the price for all shows chooses it; one fewer from all of them is that many less one,
 * one by one.
 */
export function itemBoxStep(source: unknown, state: ItemBoxState, by: 1 | -1, lang?: UiLang): ItemBoxState {
    const p = perItemOf(source);
    if (!p || typeof p.unitsLeft !== 'number') return state;
    const max = p.unitsLeft;
    const { n } = chosenIn(source, state, lang);
    if (n === null || n < 1) return { option: 'each', count: '1' };
    const next = Math.max(1, Math.min(max, n + by));
    return chooseCount(source, next);
}

/** The count chosen as a number: all of them when it is the price for all's number, else that many one by one. */
function chooseCount(source: unknown, n: number): ItemBoxState {
    const p = perItemOf(source);
    const lot = p && lotOffered(p) ? p.lot! : null;
    return lot && n === lot.units ? { option: 'lot', count: String(n) } : { option: 'each', count: String(n) };
}

/**
 * One of the two choices tapped: all of them (only while it shows), or "Choose how many", which from all of them moves the
 * count one below, so it does not count as all of them again.
 */
export function itemBoxPick(source: unknown, state: ItemBoxState, option: ItemOption, lang?: UiLang): ItemBoxState {
    const p = perItemOf(source);
    const lot = p && lotOffered(p) ? p.lot! : null;
    if (option === 'lot') return lot ? { option: 'lot', count: String(lot.units) } : state;
    const { n } = chosenIn(source, state, lang);
    if (lot && n === lot.units) return { option: 'each', count: String(Math.max(1, lot.units - 1)) };
    return { option: 'each', count: state.count };
}

/** The count typed into the stepper's box, as the state reads it (all of them again when it is the price for all's number). */
export function itemBoxTyped(source: unknown, text: string, lang?: UiLang): ItemBoxState {
    const p = perItemOf(source);
    const lot = p && lotOffered(p) ? p.lot! : null;
    const n = readCount(text, lang);
    return lot && n === lot.units ? { option: 'lot', count: text } : { option: 'each', count: text };
}

/**
 * A take-up the node refused because the listing moved on since the box read it (core ITEM_TAKE_UP_REFUSALS: the count
 * changed, they're all taken, the price for all is off, the price changed, not a whole number), from the error either app's
 * request layer throws (its `code`, and `unitsLeft` beside `units_gone`): the sentence to show in the box, in the member's
 * language. Null for any other error (`deal_open` keeps its own words). The app then reads the listing again.
 */
export function itemTakeUpRefusalIn(e: unknown): { code: ItemTakeUpRefusal; text: string } | null {
    const err = (e ?? {}) as { code?: unknown; unitsLeft?: unknown };
    if (typeof err.code !== 'string' || !(ITEM_TAKE_UP_REFUSALS as readonly string[]).includes(err.code)) return null;
    const code = err.code as ItemTakeUpRefusal;
    const count = typeof err.unitsLeft === 'number' && Number.isInteger(err.unitsLeft) && err.unitsLeft >= 0 ? err.unitsLeft : undefined;
    // units_gone without a count says "They have all been taken up." (its own sentence for none left).
    return { code, text: itemTakeUpRefusalText({ code, ...(count !== undefined ? { count } : {}) }) };
}

// ── Both sides of the deal (§2.3) ────────────────────────────────────────────────────────────────────────────────

/** A deal on a listing priced for each one: which way, how many, and what it holds (null: no figure). */
export interface ItemDeal {
    option: ItemOption;
    count: number;
    amount_c: Hundredths | null;
}

/**
 * A deal row as either app holds it, read as a per-item one: the web's (`itemOption`, `hours`) or the phone's copy
 * (`item_option`, `hours`). Null for every other deal, and for one without a whole count (`hours` is how many on such a
 * deal, design §3), which then reads as it always did.
 */
export function itemDealOf(tx: unknown): ItemDeal | null {
    const r = tx as Record<string, unknown> | null | undefined;
    if (!r || typeof r !== 'object') return null;
    const option = r.itemOption ?? r.item_option;
    if (option !== 'each' && option !== 'lot') return null;
    const count = r.hours;
    if (!isItemCount(count)) return null;
    return { option, count, amount_c: isHundredths(r.amount_c) ? r.amount_c : null };
}

/** Your deals' title, both apps (§2.3): "3 × Solar Panels", "All 20 × Solar Panels"; any other deal, its title as it is. */
export function itemDealTitle(tx: unknown, title: string): string {
    const d = itemDealOf(tx);
    return d ? perItemLines.dealTitle(d.option, d.count, title) : title;
}

/**
 * The seller's row under "Deals under way" (§2.3): "Dana · 3 for 900 Beans held · since 11 Nov", "Dana · all 20 for 5,500
 * Beans held · since 11 Nov". Null for any other deal (it keeps listingDealLines.heldRow), and a free one (nothing held).
 */
export function itemDealRow(tx: unknown, name: string, date: string): string | null {
    const d = itemDealOf(tx);
    return d && d.amount_c !== null && d.amount_c > 0 ? perItemLines.dealRow(d.option, name, d.count, d.amount_c, date) : null;
}

/**
 * The buyer's line (§2.3): "✅ You took up 3 on 11 Nov · 900 Beans held in trust", "✅ You took up all 20 on 11 Nov · 5,500
 * Beans held in trust". Null for any other deal (it keeps its own line).
 */
export function itemDealTakenLine(tx: unknown, date: string): string | null {
    const d = itemDealOf(tx);
    return d ? perItemLines.youTookUp(d.option, d.count, date, d.amount_c ?? 0) : null;
}

/**
 * The seller's stock line on their own listing (§2.3): "17 left · 3 held for buyers", from the listing and the deals under way
 * on it (their counts added: core itemsHeldIn). Just the stock while none are held; null for a listing not priced each.
 */
export function itemSellerStock(source: unknown, heldDeals: readonly object[]): string | null {
    const card = perItemCard(source);
    if (!card) return null;
    const held = itemsHeldIn(heldDeals.filter((tx) => itemDealOf(tx) !== null));
    return held > 0 ? [card.stock, perItemLines.heldForBuyers(held)].join(' · ') : card.stock;
}

/**
 * The chat's trust line for a per-item deal (§2.3: it carries the count as the push does): 'Dana took 3 of "Solar Panels".
 * 900 Beans are held in trust.' From the line's own metadata (ESCROW_FUNDED's `itemOption`, `count`, `amount_c`), never a
 * deal list's. Null for any other line, or while the buyer's name or the title is not known (the plain line stands).
 */
export function itemTrustLine(meta: unknown, buyerName: string | null | undefined, title: string | null | undefined): string | null {
    const m = meta as { itemOption?: unknown; count?: unknown; amount_c?: unknown } | null | undefined;
    if (!m || typeof m !== 'object' || !buyerName || !title) return null;
    const d = itemDealOf({ itemOption: m.itemOption, hours: m.count, amount_c: m.amount_c });
    return d && d.amount_c !== null ? perItemLines.pushTook(d.option, buyerName, d.count, title, d.amount_c) : null;
}
