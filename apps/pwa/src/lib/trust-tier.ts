/**
 * A trust tier's name as a member reads it (tiers are merit badges: the word, nothing about what it opens). Core's
 * TierName stays the English id the node and tierForCredit use; these are the phone's word() keys
 * (apps/native/utils/trust-tier.ts), shown through t() where a tier is named.
 */
import { t, word, type TierName, type WordKey } from '@beanpool/core';

export const TIER_WORDS: Readonly<Record<TierName, WordKey>> = {
    Newcomer: word('Newcomer', 'trust tier'),
    Resident: word('Resident', 'trust tier'),
    Steward: word('Steward', 'trust tier'),
    Elder: word('Elder', 'trust tier'),
};

const isTierName = (name: unknown): name is TierName => typeof name === 'string' && Object.prototype.hasOwnProperty.call(TIER_WORDS, name);

/** A tier's name in the member's language; a name this build doesn't know (a newer node's) as it came. */
export function tierWords(name: string): string {
    return isTierName(name) ? t(TIER_WORDS[name]) : name;
}
