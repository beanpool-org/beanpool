/**
 * How the routes that take up a listing answer the engine's refusals that carry a code (engine/escrow.ts acceptPost and
 * requestPost, engine/per-item.ts): the member's own take-up and request (routes/marketplace.ts) and an enterprise's
 * take-up by a keeper (routes/treasury.ts POST /api/treasury/:treasury/take-up). One copy, so the two doors answer the same
 * refusal the same way and an app reads one shape.
 */
import { DEAL_OPEN_CODE, LISTING_COPY_CODE } from '../engine/escrow.js';
import { itemTakeUpRefusalOf } from '../engine/per-item.js';
import { memberErrorText } from './member-error-text.js';

/** No deal starts on a member's copy of another community's listing (engine/escrow.ts LISTING_COPY_CODE): 409 with its code. */
export function respondCopyNoDeal(ctx: any, err: any): boolean {
    if (err?.code !== LISTING_COPY_CODE) return false;
    ctx.status = 409;
    ctx.body = { error: err.message, code: LISTING_COPY_CODE };
    return true;
}

/**
 * A take-up, a request or a release on a listing priced for each one refused (engine/per-item.ts; core ITEM_TAKE_UP_REFUSALS):
 * 409 when the listing moved on since the buyer's screen read it (price_changed, units_gone with how many are left now,
 * lot_gone, each_accept_only), 400 for a count that isn't one or a release for another number; its code beside its words, so
 * an app can refresh the listing and say what changed.
 */
export function respondItemTakeUpRefusal(ctx: any, err: any, fallback: string): boolean {
    const r = itemTakeUpRefusalOf(err);
    if (!r) return false;
    ctx.status = r.status;
    ctx.body = { error: memberErrorText(err, fallback), code: r.code, ...(r.unitsLeft !== undefined ? { unitsLeft: r.unitsLeft } : {}) };
    return true;
}

/**
 * The member already has a deal under way on this listing (engine/escrow.ts DEAL_OPEN_CODE): 409, its code, and the deal's id,
 * so an app says so and opens that deal. The deal is the caller's own (the buyer or requester this route was entitled to).
 */
export function respondDealOpen(ctx: any, err: any): boolean {
    if (err?.code !== DEAL_OPEN_CODE) return false;
    ctx.status = 409;
    ctx.body = { error: err.message, code: DEAL_OPEN_CODE, transactionId: err.transactionId };
    return true;
}
