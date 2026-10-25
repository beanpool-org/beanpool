/**
 * A shop (scratch/tools/DESIGN-shops-and-tools-fable.md §2.1, §6, §9.1; slice S1): a front window on an account, a
 * member's or an enterprise's, with a name, a category, a blurb, "how I deal", and the Offers its owner puts in it. The
 * node keeps and checks it (apps/server engine/shops.ts); both apps draw it from what is here.
 *
 * Plain values only: this file is in the barrel the phone app bundles (barrel-is-universal.test.ts). A shop's category is
 * one of the Market's (pricing-catalog.ts PRICING_CATEGORIES), the list its listings pick from, by the ids they keep; its
 * words and emoji are the apps' own for that category, so a shop and its listings always agree. A shop's text limits are
 * with the others, in text-limits.ts (SHOP_NAME_LIMIT, SHOP_BLURB_LIMIT, SHOP_HOW_TO_DEAL_LIMIT).
 */
import { PRICING_CATEGORIES, type PricingCategory } from './pricing-catalog.js';

/** A shop's category: one of the Market's, by its id. */
export type ShopCategory = PricingCategory;

/**
 * The categories a shop picks from: the Market's seventeen, in its order (Marty, 25 Oct 2026: "Seems like it should have
 * used the categories already present?"). A category picks the tools shown, the shop's emoji and where its new listings
 * start, and gates nothing.
 */
export const SHOP_CATEGORIES: readonly ShopCategory[] = PRICING_CATEGORIES.map((c) => c.id);

/** Whether `v` is one of SHOP_CATEGORIES, by its id exactly. */
export function isShopCategory(v: unknown): v is ShopCategory {
    return typeof v === 'string' && (SHOP_CATEGORIES as readonly string[]).includes(v);
}

/**
 * The one table of what became of the fourteen shop kinds a shop had before it picked a category: for each category,
 * the kinds that moved into it (`kinds`: a stored shop of that kind, apps/server db.ts moveShopKindsToCategories, and an
 * app from before categories that sends one, engine/shops.ts), and the kind nearest it whose tools it shows
 * (`toolsLike`: its own where one moved in; Tech, Health, Mindset and General had none). Each tool's manifest names its
 * categories by this column (tools/manifest.ts `categories`; __tests__/shop-categories.test.ts holds them to it).
 */
export const SHOP_CATEGORY_KINDS = {
    food: { kinds: ['food', 'baking'], toolsLike: 'food' },
    services: { kinds: ['repairs'], toolsLike: 'repairs' },
    labour: { kinds: ['labour'], toolsLike: 'labour' },
    tools: { kinds: ['tools'], toolsLike: 'tools' },
    goods: { kinds: ['buying'], toolsLike: 'buying' },
    garden: { kinds: ['seeds'], toolsLike: 'seeds' },
    housing: { kinds: ['rooms'], toolsLike: 'rooms' },
    transport: { kinds: ['rides'], toolsLike: 'rides' },
    education: { kinds: ['lessons'], toolsLike: 'lessons' },
    arts: { kinds: ['crafts'], toolsLike: 'crafts' },
    health: { kinds: [], toolsLike: 'care' },
    care: { kinds: ['care'], toolsLike: 'care' },
    animals: { kinds: ['animals'], toolsLike: 'animals' },
    tech: { kinds: [], toolsLike: 'repairs' },
    energy: { kinds: ['energy'], toolsLike: 'energy' },
    mindset: { kinds: [], toolsLike: 'lessons' },
    general: { kinds: [], toolsLike: 'tools' },
} as const satisfies Record<ShopCategory, { kinds: readonly string[]; toolsLike: string }>;

const CATEGORY_OF_KIND: ReadonlyMap<string, ShopCategory> = new Map(
    (Object.entries(SHOP_CATEGORY_KINDS) as Array<[ShopCategory, { kinds: readonly string[] }]>).flatMap(([c, row]) => row.kinds.map((k) => [k, c] as const)),
);

/** The category an old shop kind became (SHOP_CATEGORY_KINDS), or null for anything that is none of the fourteen. */
export function shopCategoryOfKind(kind: unknown): ShopCategory | null {
    return typeof kind === 'string' ? CATEGORY_OF_KIND.get(kind) ?? null : null;
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
