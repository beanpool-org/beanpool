import { type PricingGuideItem } from '@beanpool/core';

/** How long the community's price guide is asked for before the sheet goes without figures (the composer then asks for each price). */
export const STARTER_GUIDE_TIMEOUT_MS = 8_000;

/**
 * The community's price guide, for the "What could you offer?" sheet's figures (slice O2): its public GET /api/pricing-guide,
 * as the Pricing Guide sheet and the tools' `pricingGuide` read it, with nothing sent from the member. Null when the node
 * can't be reached, has no guide or answers with something else: the sheet then shows no figures and every paid draft opens
 * with its price empty. A hint for the member to see, never a price set for them. Never throws.
 */
export async function readPricingGuide(nodeUrl: string | null | undefined, fetcher: typeof fetch = fetch): Promise<PricingGuideItem[] | null> {
    const base = (nodeUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) return null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), STARTER_GUIDE_TIMEOUT_MS);
    try {
        const res = await fetcher(`${base}/api/pricing-guide`, { signal: abort.signal });
        if (!res.ok) return null;
        const data = await res.json() as { items?: unknown };
        return Array.isArray(data?.items) ? data.items as PricingGuideItem[] : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
