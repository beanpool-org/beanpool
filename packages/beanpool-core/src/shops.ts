/**
 * A shop (scratch/tools/DESIGN-shops-and-tools-fable.md §2.1, §6, §9.1; slice S1): a front window on an account, a
 * member's or an enterprise's, with a name, a kind, a blurb, "how I deal", and the Offers its owner puts in it. The
 * node keeps and checks it (apps/server engine/shops.ts); both apps draw it from what is here.
 *
 * Plain values only: this file is in the barrel the phone app bundles (barrel-is-universal.test.ts). The fourteen kinds
 * are the tool template's (tools/manifest.ts SHOP_KINDS), the ids a shop keeps; their words are the apps' own, through
 * t(). A shop's text limits are with the others, in text-limits.ts (SHOP_NAME_LIMIT, SHOP_BLURB_LIMIT,
 * SHOP_HOW_TO_DEAL_LIMIT).
 */
import { SHOP_KINDS, type ShopKind } from './tools/manifest.js';

/** Whether `kind` is one of the fourteen (SHOP_KINDS). A kind picks the tools shown and the card's icon, and gates nothing. */
export function isShopKind(kind: unknown): kind is ShopKind {
    return (SHOP_KINDS as readonly unknown[]).includes(kind);
}

/** The furthest ahead a paused shop may say it is back: a year. */
export const SHOP_BACK_ON_MAX_DAYS = 366;

/**
 * The shelf: the most of a shop's Offers featured at once (DESIGN-shops-round3-enterprise-shopfront-fable.md §0 row 7, §4;
 * Marty, 23 Oct 2026). The shopfront draws them as tiles under the banner, and the Market's shop card prefers them.
 */
export const SHOP_FEATURED_MAX = 6;

/**
 * A shop's counts, as a reader sees its listings (the node's GET /api/shops/:id): its live Offers ("things", on the board
 * or out on loan), those on the board ("available"), to borrow (lendable) and to buy (the rest), out on loan, and the
 * live ones listed in the last seven days.
 */
export interface ShopCounts {
    things: number;
    available: number;
    toBorrow: number;
    toBuy: number;
    out: number;
    newThisWeek: number;
}
