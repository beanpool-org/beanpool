/**
 * A price for each one: the node's half of slices P0 and P1 (scratch/fable-design/DESIGN-per-item-price-fable.md §3, §4; the
 * rules and every sentence are @beanpool/core per-item.ts). An Offer priced `each` holds three columns (schema.sql
 * posts.units_left, lot_price_c, lot_units), set here on every create and edit, and the count moved by its deals:
 *
 *  - `each` is an Offer's, never lent (engine/posts.ts lendColumnsOnCreate refuses the unit for a loan first), never
 *    Repeatable (the count takes its place, D4: set to 0 here), never a copy (engine/event-copy.ts copyBody makes a copy's
 *    own row 'fixed' at 0 and strips the three). Any other unit stores none of the three; leaving Each clears them.
 *  - The count is written only when the seller changed it (`unitsLeft` !== `unitsLeftWas`) and only while the row still
 *    holds `unitsLeftWas`: the edit screen sends every field back, and a blind write would undo a take-up made while it was
 *    open (§4.6). The compare is the UPDATE's own WHERE ({@link writeItemCount}), inside the edit's transaction, so a
 *    future change that yields between the check and the write still can't lose a sale; a miss is 409 `units_changed`.
 *  - A price for all is bound to the count saved with it. Sent back unchanged with the count unchanged, and still set for
 *    that count, it is left as it is; any other (a new figure, or the stored figure while it is set for another number) is
 *    new, and with the count unchanged needs `unitsLeftWas` to be the count now, as a changed count does.
 *  - A listing with a live standing deal is never edited into Each (Each is never weekly or monthly).
 *
 * The deals (P1): a take-up for a number of them or all of them holds exactly their Beans and lowers the count in the same
 * transaction ({@link reserveUnits}, the authority); the five places a deal ends settle the count through one function
 * ({@link settleItemDeal}); a request is refused ({@link assertNotAskedForItems}). The forms offer Each where the node's
 * features answer says `perItem`: every node from 1.4.1 (config/node-profile.ts PER_ITEM_BUILT).
 */
import {
    EACH, ITEM_COUNT_MAX, ITEM_TAKE_UP_REFUSALS, NOT_PER_ITEM, PER_ITEM_REFUSALS, isItemCount, isPerItem, itemColumnsRefusal, itemStockRefusal,
    itemTakeUpOf, itemTakeUpRefusalText, lotPriceIn, perItemRefusalText, wordsFor,
    type ItemColumns, type ItemTakeUp, type ItemTakeUpIn, type ItemTakeUpRefusalOf, type PerItemListing, type PerItemRefusalOf,
} from '@beanpool/core';
import type { MarketplacePost } from '@beanpool/engine';
import { db } from '../db/db.js';
// posts.ts imports this module too; the sentence is read only when an edit is refused, never while the modules load.
import { PRICE_FROZEN_ERROR } from './posts.js';

const en = wordsFor('en');

/** A refusal of a create or an edit, as the routes answer it: its status, its code, and the count now for `units_changed`. */
export interface ItemRefusalError extends Error {
    status: number;
    statusCode: number;
    code: PerItemRefusalOf['code'];
    unitsLeft?: number;
}

function itemRefusal(r: PerItemRefusalOf): ItemRefusalError {
    const status = r.code === 'units_changed' ? 409 : 400;
    return Object.assign(new Error(perItemRefusalText(r, en)), {
        status, statusCode: status, code: r.code, ...(r.code === 'units_changed' ? { unitsLeft: r.count ?? 0 } : {}),
    });
}

/** What a route sends for a per-item refusal: its code, and the count now when it changed under the seller. */
export function itemRefusalOf(e: unknown): { status: number; code: string; unitsLeft?: number } | null {
    const r = e as Partial<ItemRefusalError> | null;
    if (!r || typeof r.code !== 'string' || !(PER_ITEM_REFUSALS as readonly string[]).includes(r.code) || typeof r.status !== 'number') return null;
    return { status: r.status, code: r.code, ...(typeof r.unitsLeft === 'number' ? { unitsLeft: r.unitsLeft } : {}) };
}

/** A lot as sent: `{ price_c }` or none; anything else refused. */
function lotIn(raw: unknown): number | null {
    const lot = lotPriceIn(raw);
    if (!lot.ok) throw itemRefusal({ code: 'lot_price_refused' });
    return lot.price_c;
}

function assertColumns(price_c: number, cols: ItemColumns): ItemColumns {
    const refused = itemColumnsRefusal(price_c, cols);
    if (refused) throw itemRefusal(refused);
    return cols;
}

/**
 * A new listing's three columns: none unless it is priced `each`; then an Offer's, with a count from 1 to 9,999 and, if
 * sent, a price for all of exactly that many. Before anything is written.
 */
export function itemColumnsOnCreate(type: string, priceType: string, price_c: number, raw: { unitsLeft?: unknown; lot?: unknown } | undefined): ItemColumns {
    if (priceType !== EACH) return { ...NOT_PER_ITEM };
    if (type !== 'offer') throw itemRefusal({ code: 'each_offer_only' });
    const units = raw?.unitsLeft;
    if (!isItemCount(units)) throw itemRefusal({ code: 'units_refused' });
    const lot = lotIn(raw?.lot);
    return assertColumns(price_c, { units_left: units, lot_price_c: lot, lot_units: lot === null ? null : units });
}

/** An edit's three columns, and the count's guarded write when the edit changes it (`from` is what the row must still hold). */
export interface ItemEdit {
    cols: ItemColumns;
    count: { from: number | null; to: number } | null;
}

/**
 * An edit's three columns, or null when it leaves them as they are (a listing that is not, and does not become, priced
 * `each`). Sets `updates.repeatable` to 0 for one that is. Refused before anything is written: a unit changed under an open
 * deal is engine/posts.ts assertPriceNotFrozen's, which runs first; one changed into Each under a live standing deal, whose
 * periods that check skips, is this one's.
 */
export function itemColumnsOnEdit(existing: MarketplacePost, updates: Record<string, any>): ItemEdit | null {
    const wasEach = isPerItem(existing);
    if ((updates.priceType ?? existing.priceType) !== EACH) return wasEach ? { cols: { ...NOT_PER_ITEM }, count: null } : null;
    if (existing.type !== 'offer') throw itemRefusal({ code: 'each_offer_only' });
    // Each is never weekly or monthly (design §1: no standing deal). A standing deal's periods don't freeze the unit
    // (assertPriceNotFrozen), so a live one is refused here as a unit change under an open deal is: made Each, the listing
    // would stop being Repeatable and its next period would take it off the board, ending any other standing deal on it.
    if (!wasEach && db.prepare("SELECT 1 FROM standing_deals WHERE post_id = ? AND phase != 'ended' LIMIT 1").get(existing.id)) {
        throw Object.assign(new Error(PRICE_FROZEN_ERROR), { status: 409, statusCode: 409, code: 'price_frozen' });
    }
    updates.repeatable = false;
    const stored = wasEach ? (existing.unitsLeft ?? null) : null;
    let units = stored;
    let count: ItemEdit['count'] = null;
    const sent = updates.unitsLeft;
    if (!wasEach || (sent !== undefined && sent !== updates.unitsLeftWas)) {
        if (wasEach && sent === 0) throw itemRefusal({ code: 'units_zero' });
        if (!isItemCount(sent)) throw itemRefusal({ code: 'units_refused' });
        // Before the transaction, a plain refusal; the write's own WHERE is the authority (writeItemCount).
        if (wasEach && updates.unitsLeftWas !== stored) throw itemRefusal({ code: 'units_changed', count: stored ?? 0 });
        units = sent;
        count = { from: stored, to: sent };
    }
    let lot_price_c = wasEach ? (existing.lot?.price_c ?? null) : null;
    let lot_units = wasEach ? (existing.lot?.units ?? null) : null;
    if (updates.lot !== undefined) {
        const price = lotIn(updates.lot);
        // Sent back as it is, with the count left as it is and still for that count, a price for all is left alone. Sent at
        // its stored figure while set for another number (20 for 5,000 with 17 left, typed again for the 17), it is new: the
        // seller's form said "All 17 for 5,000", so it is bound to the 17, not kept for 20 where it is not on offer.
        if (price === null) { lot_price_c = null; lot_units = null; }
        else if (count !== null || price !== lot_price_c || lot_units !== units) {
            // A new price is for the count the seller saw (§4.6, §5): with the count left as it is, the row must still hold
            // `unitsLeftWas`, line for line the changed count's rule above, else 409 with the count now.
            if (count === null && updates.unitsLeftWas !== stored) throw itemRefusal({ code: 'units_changed', count: stored ?? 0 });
            lot_price_c = price; lot_units = units;
        }
    }
    const price_c = typeof updates.price_c === 'number' ? updates.price_c : existing.price_c;
    return { cols: assertColumns(price_c, { units_left: units, lot_price_c, lot_units }), count };
}

/**
 * The count's write, inside the edit's transaction: one UPDATE that must change exactly the one row still holding what the
 * seller saw. None changed (a take-up moved it since): 409 `units_changed` with the count now, and the throw unwinds the edit.
 */
export function writeItemCount(id: string, count: NonNullable<ItemEdit['count']>): void {
    const res = db.prepare('UPDATE posts SET units_left = ? WHERE id = ? AND units_left IS ?').run(count.to, id, count.from);
    if (res.changes === 1) return;
    const now = (db.prepare('SELECT units_left FROM posts WHERE id = ?').get(id) as { units_left: number | null } | undefined)?.units_left;
    throw itemRefusal({ code: 'units_changed', count: now ?? 0 });
}

// ── The deals (slice P1: design §4.1-§4.5, §5) ──────────────────────────────────────────────────────────────────

/** A take-up, request or release refused (core ITEM_TAKE_UP_REFUSALS), as the routes answer it: status, code, count now. */
export interface ItemTakeUpError extends Error {
    status: number;
    statusCode: number;
    code: ItemTakeUpRefusalOf['code'];
    unitsLeft?: number;
}

/** The refusal, its sentence in English (translated on the way out); `count_refused` and `deal_count_fixed` are a 400. */
export function itemTakeUpRefusal(r: ItemTakeUpRefusalOf): ItemTakeUpError {
    const status = r.code === 'count_refused' || r.code === 'deal_count_fixed' ? 400 : 409;
    return Object.assign(new Error(itemTakeUpRefusalText(r, en)), {
        status, statusCode: status, code: r.code, ...(r.code === 'units_gone' ? { unitsLeft: r.count ?? 0 } : {}),
    });
}

/** What a route sends for a take-up refusal: its code, and how many are left now when that is why. */
export function itemTakeUpRefusalOf(e: unknown): { status: number; code: string; unitsLeft?: number } | null {
    const r = e as Partial<ItemTakeUpError> | null;
    if (!r || typeof r.code !== 'string' || !(ITEM_TAKE_UP_REFUSALS as readonly string[]).includes(r.code) || typeof r.status !== 'number') return null;
    return { status: r.status, code: r.code, ...(typeof r.unitsLeft === 'number' ? { unitsLeft: r.unitsLeft } : {}) };
}

/** A listing priced for each one as core reads it, from its post (camelCase, getPosts) or its raw row. */
function listingOf(p: any): PerItemListing {
    if (!p) return { priceType: null, price_c: 0 };
    if ('price_type' in p) {
        return {
            priceType: p.price_type, price_c: p.price_c, unitsLeft: p.units_left,
            lot: Number.isInteger(p.lot_units) && Number.isInteger(p.lot_price_c) ? { units: p.lot_units, price_c: p.lot_price_c } : null,
        };
    }
    return { priceType: p.priceType, price_c: p.price_c, unitsLeft: p.unitsLeft, lot: p.lot ?? null };
}

/**
 * The take-up of a listing priced for each one (acceptPost's price, design §4.1): how many, which way, and the Beans that go
 * into trust, from the listing as stored and the total the buyer's screen showed; refused before anything is held.
 */
export function itemTakeUpFor(post: MarketplacePost, take: ItemTakeUpIn | undefined): ItemTakeUp {
    const r = itemTakeUpOf(listingOf(post), take ?? {});
    if (!r.ok) throw itemTakeUpRefusal(r.refusal);
    return r.take;
}

/** Still there, as the listing was read: asked once before the hold, a plain refusal with no rollback (reserveUnits decides). */
export function assertItemStock(post: MarketplacePost, take: ItemTakeUp): void {
    const refused = itemStockRefusal(listingOf(post), take);
    if (refused) throw itemTakeUpRefusal(refused);
}

/**
 * The count's half of a take-up, INSIDE the hold's conservingTransaction (design §4.2): one UPDATE that must change exactly the
 * listing's one row, still active, still priced for each one at the price the amount was worked out from, with that many
 * still left; for all of them, still exactly the number and the price for all the buyer saw, and none left after. Nothing
 * between the checks and this write yields (the node runs one request at a time), but this WHERE is the authority all the
 * same, so a future change that yields can't oversell: no row changed throws (`units_gone` with what is left, `lot_gone`, or
 * `price_changed`), and the throw unwinds the hold and the ledger with it. Never takes the listing off the board.
 */
export function reserveUnits(postId: string, price_c: number, take: ItemTakeUp, at: string): void {
    const res = take.option === 'lot'
        ? db.prepare(`UPDATE posts SET units_left = 0, updated_at = ?
                      WHERE id = ? AND status = 'active' AND active = 1 AND price_type = 'each' AND units_left = ? AND lot_units = ? AND lot_price_c = ?`)
            .run(at, postId, take.n, take.n, take.amount_c)
        : db.prepare(`UPDATE posts SET units_left = units_left - ?, updated_at = ?
                      WHERE id = ? AND status = 'active' AND active = 1 AND price_type = 'each' AND price_c = ? AND units_left >= ?`)
            .run(take.n, at, postId, price_c, take.n);
    if (res.changes === 1) return;
    const now = db.prepare('SELECT price_type, price_c, units_left, lot_units, lot_price_c FROM posts WHERE id = ?').get(postId);
    throw itemTakeUpRefusal(itemStockRefusal(listingOf(now), take) ?? { code: 'price_changed' });
}

/** A deal row as settleItemDeal reads it: its own figures, never the listing's price. */
export interface ItemDealRow {
    id: string;
    post_id: string;
    hours: unknown;
    item_option: unknown;
}

/** Whether a deal row is a per-item one (item_option set): those end through {@link settleItemDeal}, every other as before. */
export function isItemDeal(row: { item_option?: unknown } | null | undefined): row is ItemDealRow {
    return row?.item_option === 'each' || row?.item_option === 'lot';
}

/**
 * A per-item deal ended (design §4.3, D1, D3): the one copy, called for a row with item_option from the five places a deal ends
 * (engine/escrow.ts: the release, the cancel, and the three rulings), INSIDE that step's conservingTransaction, so the count
 * and the Beans move together or not at all. It reads the row's own count (`hours`), never the listing's live price.
 *
 *  - returned (a cancel, the refund ruling): the count the deal held goes back. The status is not touched: a paused listing
 *    stays paused, a removed one removed. Never past 9,999 (the seller may have raised the count while the deal was held),
 *    so the refund itself can never be refused by the count's CHECK.
 *  - sold (a release, the release and split rulings): nothing goes back; once none are left and no other deal on it is held,
 *    the listing closes, completed ("Sold out"), as a one-off listing does when it sells. A removed listing stays removed.
 *
 * A count is not money: nothing here reads or writes a balance.
 */
export function settleItemDeal(row: ItemDealRow, outcome: 'returned' | 'sold', at: string): void {
    if (outcome === 'returned') {
        const n = Number(row.hours);
        if (!isItemCount(n)) return;
        db.prepare(`UPDATE posts SET units_left = MIN(units_left + ?, ${ITEM_COUNT_MAX}), updated_at = ? WHERE id = ? AND price_type = 'each' AND units_left IS NOT NULL`)
            .run(n, at, row.post_id);
        return;
    }
    db.prepare(`UPDATE posts SET status = 'completed', completed_at = ?, updated_at = ?
                WHERE id = ? AND price_type = 'each' AND units_left = 0 AND status IN ('active', 'paused')
                  AND NOT EXISTS (SELECT 1 FROM marketplace_transactions WHERE post_id = ? AND status = 'pending' AND id != ?)`)
        .run(at, at, row.post_id, row.post_id, row.id);
}

/**
 * The doors that ask before they hold (requestPost, approvePostRequest) never open on a listing priced for each one (design
 * §4.5): it is taken up in one step, so nothing ever waits unfunded against its count. 409 `each_accept_only`.
 */
export function assertNotAskedForItems(post: { priceType?: unknown; price_type?: unknown }): void {
    if (isPerItem({ priceType: post.priceType ?? post.price_type })) throw itemTakeUpRefusal({ code: 'each_accept_only' });
}
