/**
 * A shop's refusal, answered where a listing is made, edited or put back up (routes/marketplace.ts, routes/treasury.ts):
 * its status (400, 403 or 409), its sentence and its code (engine/shops.ts ShopRefusal), so an app can say why.
 */
import { ShopRefusal } from '../engine/shops.js';

/** Answers `e` when it is a shop's refusal, and says so; false for anything else. */
export function respondShopRefusal(ctx: { status: number; body: unknown }, e: unknown): boolean {
    if (!(e instanceof ShopRefusal)) return false;
    ctx.status = e.status;
    ctx.body = { error: e.message, code: e.code };
    return true;
}
