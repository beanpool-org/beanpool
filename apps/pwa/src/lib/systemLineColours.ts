/**
 * The colours of a system line in a direct message (the centred pill between the bubbles).
 *
 * A trade's three lines take the colour library's deal roles (packages/beanpool-core/src/brand-colours.ts `deal`, the
 * phone's tints too): Beans held in trust, released to the provider, cancelled. Marty, 15 Oct, on a web DM in dark:
 * "hard to read the transactional info": the old dark-green and dark-red words sat on a pale wash over the dark chat,
 * 1.5-2.2:1. Light is as it was (the roles' light values are the old ones; the tint is laid at the old 40 %).
 * Every other system line keeps the page's hover grey and its secondary words.
 */
import { DEAL_TINT_ALPHA } from '@beanpool/core/brand-colours';

const DEAL_LINES = { ESCROW_FUNDED: 'held', ESCROW_RELEASED: 'released', ESCROW_CANCELLED: 'cancelled' } as const;

export interface SystemLineColours {
    background: string;
    color: string;
    border: string;
}

export function systemLineColours(systemType: string | null | undefined): SystemLineColours {
    const deal = systemType && systemType in DEAL_LINES ? DEAL_LINES[systemType as keyof typeof DEAL_LINES] : null;
    if (!deal) return { background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: 'transparent' };
    return {
        // The tint at 40 %: in light exactly the old rgba(…, 0.4), from the library's colour.
        background: `color-mix(in srgb, var(--bp-deal-${deal}-tint) ${DEAL_TINT_ALPHA * 100}%, transparent)`,
        color: `var(--bp-deal-${deal}-ink)`,
        border: `var(--bp-deal-${deal}-border)`,
    };
}
