/**
 * A post author's tier, for the badges on cards and the Elder card treatment.
 *
 * `energyCycled` is the post's author_energy_cycled. The node fills it with the author's tier credit
 * (what they did: vouch + earned + granted, never the known grant), so the tier here is the one the author's own
 * Ledger shows. The thresholds are @beanpool/core's — never a copy. Pure, so vitest can hold it to core.
 */
import { tierForCredit, word, type TierLevel, type TierName, type WordKey } from '@beanpool/core';

/** Names the shared trust colours (constants/colors.ts `trust.*`), resolved from the active theme at render. */
export type TierToken = 'newcomer' | 'resident' | 'steward' | 'elder';

const TIER_TOKEN: Record<TierName, TierToken> = {
    Newcomer: 'newcomer', Resident: 'resident', Steward: 'steward', Elder: 'elder',
};

/** Each tier's name as a member reads it: word() keys, shown through t() (core's TierName stays the English id). */
export const TIER_WORDS: Readonly<Record<TierName, WordKey>> = {
    Newcomer: word('Newcomer', 'trust tier'),
    Resident: word('Resident', 'trust tier'),
    Steward: word('Steward', 'trust tier'),
    Elder: word('Elder', 'trust tier'),
};

export function getTrustTier(energyCycled: number = 0): TierLevel & { label: TierName; token: TierToken } {
    const tier = tierForCredit(energyCycled);
    return { ...tier, label: tier.name, token: TIER_TOKEN[tier.name] };
}

export function isElder(energyCycled: number = 0): boolean {
    return tierForCredit(energyCycled).name === 'Elder';
}
