import type { PricingGuideItem } from '@beanpool/core';
import { request } from './api';

/**
 * The community's price guide, for the "What could you offer?" dialog's figures (slice O2): its public GET
 * /api/pricing-guide, as the Pricing Guide and the tools' `pricingGuide` read it. Null when the node can't be reached, has
 * no guide or answers with something else: the dialog then shows no figures and every paid draft opens with its price empty.
 * A hint for the member to see, never a price set for them. Never throws.
 */
export async function readPricingGuide(): Promise<PricingGuideItem[] | null> {
    try {
        const data = await request<{ items?: unknown }>('GET', '/api/pricing-guide');
        return Array.isArray(data?.items) ? data.items as PricingGuideItem[] : null;
    } catch {
        return null;
    }
}
