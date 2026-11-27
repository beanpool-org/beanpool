/**
 * A create or an edit of a listing priced for each one refused (engine/per-item.ts), answered where a listing is made or
 * edited: a member's own (routes/marketplace.ts) and an enterprise's Offer made by a keeper (routes/treasury.ts POST
 * /api/treasury/:treasury/offer). One copy, so the two doors answer the same count the same way and an app reads one shape.
 */
import { itemRefusalOf } from '../engine/per-item.js';
import { memberErrorText } from './member-error-text.js';

/**
 * 400, or 409 `units_changed` with how many are left now, and the refusal's code, so an app can say which field and refresh
 * the count. False for anything else.
 */
export function respondItemRefusal(ctx: any, err: any, fallback: string): boolean {
    const r = itemRefusalOf(err);
    if (!r) return false;
    ctx.status = r.status;
    ctx.body = { error: memberErrorText(err, fallback), code: r.code, ...(r.unitsLeft !== undefined ? { unitsLeft: r.unitsLeft } : {}) };
    return true;
}
