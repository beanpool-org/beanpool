/**
 * A post author's tier, for the badges on cards and the Elder card treatment.
 *
 * `energyCycled` is the post's author_energy_cycled. The node fills it with the author's tier credit
 * (vouch + earned + granted = CREDIT_BASE_FLOOR − floor), so the tier here is the one the author's own
 * Ledger shows. The thresholds are @beanpool/core's — never a copy. Pure, so vitest can hold it to core.
 */
import { tierForCredit, type TierLevel, type TierName } from '@beanpool/core';

/** Names the shared trust colours (constants/colors.ts `trust.*`), resolved from the active theme at render. */
export type TierToken = 'newcomer' | 'resident' | 'steward' | 'elder';

const TIER_TOKEN: Record<TierName, TierToken> = {
    Newcomer: 'newcomer', Resident: 'resident', Steward: 'steward', Elder: 'elder',
};

export function getTrustTier(energyCycled: number = 0): TierLevel & { label: TierName; token: TierToken } {
    const tier = tierForCredit(energyCycled);
    return { ...tier, label: tier.name, token: TIER_TOKEN[tier.name] };
}

export function isElder(energyCycled: number = 0): boolean {
    return tierForCredit(energyCycled).name === 'Elder';
}
