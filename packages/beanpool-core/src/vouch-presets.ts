/**
 * Vouches and voucher budgets (scratch/fable-design/DESIGN-invites-and-names-list-amend2-fable.md §3, §4; Marty's decisions
 * of 5 Nov, §9 and §10). Constants, not settings: the server checks a fixed set, and both apps draw the same picks.
 *
 * - **The vouch** is a pick of VOUCH_PRESETS, on an invite or from a member's profile. One voucher's vouches for one person
 *   come to at most VOUCH_MAX in all: a first vouch, then raises (§9 rule 1). At most VOUCHES_PER_PERSON vouchers' vouches
 *   count for one person (§9 rule 2).
 * - **A budget level** (an appointment, a "set to", the community's default for an appointment) is VOUCHER_BUDGET_MIN to
 *   VOUCHER_BUDGET_MAX in VOUCHER_BUDGET_STEP (§10 rule 1). What a voucher has in hand, left plus held on unused invites,
 *   is never above VOUCHER_BUDGET_MAX (§10 rule 3).
 * - **A member's credit-line gift** (slice G1) is at most MEMBER_GIFT_MAX, the community's setting 0 (off) to it.
 *
 * Nothing here is a Bean: a budget is what a voucher may give as credit line, never a balance.
 */

export const VOUCH_PRESETS = [25, 50, 75, 100] as const;
export type VouchPreset = (typeof VOUCH_PRESETS)[number];

/** The most one voucher's vouches for one person come to, first vouch and raises together. */
export const VOUCH_MAX = 100;

/** At most this many vouchers' vouches count for one person. */
export const VOUCHES_PER_PERSON = 3;

export const VOUCHER_BUDGET_MIN = 100;
export const VOUCHER_BUDGET_MAX = 2000;
export const VOUCHER_BUDGET_STEP = 100;
/** What an appointment is prefilled with until the owner sets the community's own (node_config `voucher_budget`). */
export const VOUCHER_BUDGET_DEFAULT = 1000;

export const MEMBER_GIFT_DEFAULT = 100;
export const MEMBER_GIFT_MAX = VOUCH_MAX;

/** Whether `n` is one of the vouch presets: the only amounts a vouch may be. */
export function isVouchPreset(n: unknown): n is VouchPreset {
    return typeof n === 'number' && (VOUCH_PRESETS as readonly number[]).includes(n);
}

/** Whether `n` is a budget level: a whole number from 100 to 2,000 in steps of 100. */
export function isBudgetLevel(n: unknown): n is number {
    return typeof n === 'number' && Number.isInteger(n) && n >= VOUCHER_BUDGET_MIN && n <= VOUCHER_BUDGET_MAX && n % VOUCHER_BUDGET_STEP === 0;
}

/** Whether `n` is a member's credit-line gift setting: a whole number from 0 (off) to MEMBER_GIFT_MAX. */
export function isMemberGiftSetting(n: unknown): n is number {
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MEMBER_GIFT_MAX;
}
