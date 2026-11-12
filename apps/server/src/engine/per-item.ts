/**
 * A price for each one: the node's half of slice P0 (scratch/fable-design/DESIGN-per-item-price-fable.md §3, §4.6; the rules and
 * every sentence are @beanpool/core per-item.ts). An Offer priced `each` holds three columns (schema.sql posts.units_left,
 * lot_price_c, lot_units), set here on every create and edit and nowhere else in P0:
 *
 *  - `each` is an Offer's, never lent (engine/posts.ts lendColumnsOnCreate refuses the unit for a loan first), never
 *    Repeatable (the count takes its place, D4: set to 0 here), never a copy (engine/event-copy.ts copyBody makes a copy's
 *    own row 'fixed' at 0 and strips the three). Any other unit stores none of the three; leaving Each clears them.
 *  - The count is written only when the seller changed it (`unitsLeft` !== `unitsLeftWas`) and only while the row still
 *    holds `unitsLeftWas`: the edit screen sends every field back, and a blind write would undo a take-up made while it was
 *    open (§4.6). The compare is the UPDATE's own WHERE ({@link writeItemCount}), inside the edit's transaction, so a
 *    future change that yields between the check and the write still can't lose a sale; a miss is 409 `units_changed`.
 *  - A price for all is bound to the count saved with it. Sent back unchanged with the count unchanged, it keeps its own.
 *
 * The deals (take-up with a number or all, the count held with the Beans, the five ends) are slice P1's. Until then no deal
 * starts on a listing priced for each one ({@link assertNoItemDealYet}), and the forms don't offer Each: the node's features
 * answer has no `perItem` until every slice is in (config/node-profile.ts).
 */
import {
    EACH, NOT_PER_ITEM, PER_ITEM_REFUSALS, isItemCount, isPerItem, itemColumnsRefusal, lotPriceIn, perItemRefusalText, word, wordsFor,
    type ItemColumns, type PerItemRefusalOf,
} from '@beanpool/core';
import type { MarketplacePost } from '@beanpool/engine';
import { db } from '../db/db.js';

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
 * deal is engine/posts.ts assertPriceNotFrozen's, which runs first.
 */
export function itemColumnsOnEdit(existing: MarketplacePost, updates: Record<string, any>): ItemEdit | null {
    const wasEach = isPerItem(existing);
    if ((updates.priceType ?? existing.priceType) !== EACH) return wasEach ? { cols: { ...NOT_PER_ITEM }, count: null } : null;
    if (existing.type !== 'offer') throw itemRefusal({ code: 'each_offer_only' });
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
        // Sent back as it is, with the count left as it is, a price for all keeps the number it was set for.
        if (price === null) { lot_price_c = null; lot_units = null; }
        else if (count !== null || price !== lot_price_c) { lot_price_c = price; lot_units = units; }
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

/** P0's answer at every door a deal starts by: slice P1 replaces it with the take-up of a number, or all of them. */
export const ITEM_DEALS_NOT_YET = word("This listing can't be taken up yet.");
export const ITEM_DEALS_NOT_YET_CODE = 'each_not_yet';

/** No deal starts on a listing priced for each one until P1: its count would not move with the Beans (design §4). */
export function assertNoItemDealYet(post: { priceType?: unknown; price_type?: unknown }): void {
    if (isPerItem({ priceType: post.priceType ?? post.price_type })) {
        throw Object.assign(new Error(ITEM_DEALS_NOT_YET), { status: 409, statusCode: 409, code: ITEM_DEALS_NOT_YET_CODE });
    }
}
