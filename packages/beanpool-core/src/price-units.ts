/**
 * Listing price units (`posts.price_type`): one canonical list, its feature gate on older nodes, and how every unit is
 * charged in a one-off deal. Imported by both apps and the server so no switch on `price_type` can silently treat a new
 * unit as something else.
 *
 * Pure: no I/O, no Node built-ins (the barrel is bundled for the phone).
 */

/**
 * Every listing price unit the node accepts, in the order the create and edit forms offer them:
 * Total (`fixed`), Each (`each`, Offers only), per hour, per day, per week, per month, per year, per kilo.
 */
export const PRICE_UNITS = Object.freeze([
    'fixed',
    'each',
    'hourly',
    'daily',
    'weekly',
    'monthly',
    'yearly',
    'per_kg',
] as const);

export type PriceUnit = (typeof PRICE_UNITS)[number];

/** Whether `v` is one of the node's known listing price units. */
export function isPriceUnit(v: unknown): v is PriceUnit {
    return typeof v === 'string' && (PRICE_UNITS as readonly string[]).includes(v);
}

/**
 * Is the node's features answer offering per year (`yearly`) and per kilo (`per_kg`)?
 * Absent on older nodes, which refuse unknown `price_type` values on create and edit: forms hide both units there
 * (following how `perItemOffered` gates `each`).
 */
export function kgYearPriceUnitsOffered(features: { priceUnitsKgYear?: unknown } | null | undefined): boolean {
    return features?.priceUnitsKgYear === true;
}

/**
 * How a listing's price unit is charged when taken up in a one-off deal:
 *  - `'fixed'`: the deal amount is the posted price (`price_c`), no quantity required and never re-rated at release
 *    (`fixed`, `per_kg`).
 *  - `'each'`: Offers only, whole-number item count or lot price (`per-item.ts`).
 *  - `'quantity'`: posted price × quantity (`dealAmountFor(price_c, hours)`), re-rated on confirmed quantity at release
 *    (`hourly`, `daily`, `weekly`, `monthly`, `yearly`). Note: `weekly` and `monthly` with `price_c > 0` make a standing
 *    deal when taken up with `standing` (`standing-deal.ts`); without `standing` (or when Free / lendable) they follow
 *    this one-off quantity rule. `yearly` is always one-off because `standing_deals.period_unit` is `('week', 'month')`.
 */
export type PriceUnitDealKind = 'fixed' | 'each' | 'quantity';

/** Exhaustive deal-charging rule for every known price unit (no silent default). */
export function priceUnitDealKind(priceType: PriceUnit): PriceUnitDealKind {
    switch (priceType) {
        case 'fixed':
        case 'per_kg':
            return 'fixed';
        case 'each':
            return 'each';
        case 'hourly':
        case 'daily':
        case 'weekly':
        case 'monthly':
        case 'yearly':
            return 'quantity';
        default: {
            const _exhaustive: never = priceType;
            throw new RangeError(`Unknown price type: ${String(_exhaustive)}`);
        }
    }
}

/**
 * Whether a listing's price unit asks for a quantity (`hours` on the wire) on a one-off deal.
 * Null/undefined defaults to `'fixed'` (false); an unknown string returns false.
 */
export function priceUnitTakesQuantity(priceType: string | null | undefined): boolean {
    const pt = priceType ?? 'fixed';
    if (!isPriceUnit(pt)) return false;
    return priceUnitDealKind(pt) === 'quantity';
}
