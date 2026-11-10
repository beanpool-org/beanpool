/**
 * Vouches and voucher budgets (scratch/fable-design/DESIGN-invites-and-names-list-amend2-fable.md §3, §4; Marty's decisions
 * of 5 Nov, §9 and §10). Constants, not settings: the server checks a fixed set, and both apps draw the same picks.
 *
 * - **The vouch** is a pick of VOUCH_PRESETS, on an invite or from a member's profile. One voucher's vouches for one person
 *   come to at most VOUCH_MAX in all: a first vouch, then raises (§9 rule 1). At most VOUCHES_PER_PERSON vouchers' vouches
 *   count for one person (§9 rule 2), PERSON_VOUCH_MAX in all.
 * - **An owner** (Marty, 9 Nov) has no budget limit and picks from OWNER_VOUCH_PRESETS (200 and 500 too), up to
 *   OWNER_VOUCH_MAX for one person; a person an owner vouched for may hold PERSON_VOUCH_MAX_WITH_OWNER in all. Admins and
 *   every other voucher: as above.
 * - **A budget level** (an appointment, a "set to", the community's default for an appointment) is VOUCHER_BUDGET_MIN to
 *   VOUCHER_BUDGET_MAX in VOUCHER_BUDGET_STEP (§10 rule 1). What a voucher has in hand, left plus held on unused invites,
 *   is never above VOUCHER_BUDGET_MAX (§10 rule 3).
 * - **A member's credit-line gift** (slice G1) is at most MEMBER_GIFT_MAX, the community's setting 0 (off) to it.
 *
 * Nothing here is a Bean: a budget is what a voucher may give as credit line, never a balance.
 */

import { formatNumber, t, word } from './words.js';

export const VOUCH_PRESETS = [25, 50, 75, 100] as const;
export type VouchPreset = (typeof VOUCH_PRESETS)[number];

/**
 * An owner's picks (Marty, 9 Nov): the same four, and 200 and 500. Nobody else may vouch 200 or 500. An owner vouches with
 * no budget limit: every vouch is still a line in their allocation ledger, but never drawn from a budget.
 */
export const OWNER_VOUCH_PRESETS = [25, 50, 75, 100, 200, 500] as const;
export type OwnerVouchPreset = (typeof OWNER_VOUCH_PRESETS)[number];

/** The most one voucher's vouches for one person come to, first vouch and raises together. */
export const VOUCH_MAX = 100;
/** The same for an owner's vouches: one 500, or smaller ones raised to it. */
export const OWNER_VOUCH_MAX = 500;

/** At most this many vouchers' vouches count for one person. An owner's vouch is never refused by it (it may top them up). */
export const VOUCHES_PER_PERSON = 3;

/** The most every vouch for one person comes to: three vouchers at 100 (Marty, 9 Nov) ... */
export const PERSON_VOUCH_MAX = 300;
/** ... and once an owner has vouched for them (or is vouching now), 500. */
export const PERSON_VOUCH_MAX_WITH_OWNER = 500;

export const VOUCHER_BUDGET_MIN = 100;
export const VOUCHER_BUDGET_MAX = 2000;
export const VOUCHER_BUDGET_STEP = 100;
/** What an appointment is prefilled with until the owner sets the community's own (node_config `voucher_budget`). */
export const VOUCHER_BUDGET_DEFAULT = 1000;

export const MEMBER_GIFT_DEFAULT = 100;
export const MEMBER_GIFT_MAX = VOUCH_MAX;

/** Whether `n` is one of the vouch presets: the only amounts a vouch may be. */
export function isVouchPreset(n: unknown): n is VouchPreset {
    return typeof n === 'number' && (VOUCH_PRESETS as readonly unknown[]).includes(n);
}

/** Whether `n` is one of an owner's vouch presets (25 to 500): the only amounts an owner's vouch may be. */
export function isOwnerVouchPreset(n: unknown): n is OwnerVouchPreset {
    return typeof n === 'number' && (OWNER_VOUCH_PRESETS as readonly unknown[]).includes(n);
}

/** The presets a voucher picks from: an owner's six, or everyone else's four. */
export function vouchPresetsFor(owner: boolean): readonly number[] {
    return owner ? OWNER_VOUCH_PRESETS : VOUCH_PRESETS;
}

/** What one voucher's vouches for one person may come to: 500 for an owner, 100 for anyone else. */
export function vouchMaxFor(owner: boolean): number {
    return owner ? OWNER_VOUCH_MAX : VOUCH_MAX;
}

/** What every vouch for one person may come to: 500 once an owner vouched for them, 300 otherwise. */
export function personVouchMax(ownerVouched: boolean): number {
    return ownerVouched ? PERSON_VOUCH_MAX_WITH_OWNER : PERSON_VOUCH_MAX;
}

/** Whether `n` is a budget level: a whole number from 100 to 2,000 in steps of 100. */
export function isBudgetLevel(n: unknown): n is number {
    return typeof n === 'number' && Number.isInteger(n) && n >= VOUCHER_BUDGET_MIN && n <= VOUCHER_BUDGET_MAX && n % VOUCHER_BUDGET_STEP === 0;
}

/** Whether `n` is a member's credit-line gift setting: a whole number from 0 (off) to MEMBER_GIFT_MAX. */
export function isMemberGiftSetting(n: unknown): n is number {
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MEMBER_GIFT_MAX;
}

export const VOUCH_PRESET_WORDS = {
    label: word('Vouch for them'),
    none: word('None'),
    fromBudget: word('From your budget: {left} of {total} left'),
    fromBudgetNoLimit: word('From your budget: No limit'),
    noLimit: word('No limit'),
    notEnough: word('Not enough budget left'),
    noneLeft: word('No budget left. Ask an owner for more.'),
    notAVoucher: word('You aren’t a voucher here, so you can’t vouch for anyone. An owner or the credit committee makes vouchers.'),
    beans: word('{amount} Beans'),
    noOfflineVouch: word('You can’t vouch on an offline ticket. Choose None to make one, or try again when you’re connected.'),
    vouchFor: word('Vouch for @{name}'),
    raiseVouchFor: word('Raise vouch for @{name}'),
    alreadyVouched: word('You’ve already vouched for @{name}.'),
    threeVouches: word('@{name} has three vouches.'),
    belowZero: word('@{name} is below zero: a credit-line gift or a Decision can help.'),
    invitedBy: word('Invited by @{name}'),
    ledgerVouchedBy: word('vouched by @{name}'),
    // The Ledger's one line for the vouches a member holds (I3; DESIGN-invites-vouching-review-fable.md §2): how much of the
    // credit line, and who stood behind it, named whatever their role. One voucher: one sentence. Two or more: the total once,
    // then each voucher with their part, in the order they vouched (ledgerCreditLine below).
    ledgerCreditLine: word('Your credit line: {amount}, vouched by @{name}'),
    ledgerCreditLineMany: word('Your credit line: {total} · vouched by {vouchers}'),
    ledgerCreditLineVoucher: word('@{name} {amount}'),
    ledgerCreditLineList: word('{list}, {item}'),
    ledgerBudget: word('Your budget: {left} of {total} left'),
    ledgerBudgetNoLimit: word('Your budget: No limit'),
    budgetHistory: word('Budget history'),
    askForMore: word('Ask for more'),
    askForMoreHelp: word('To get a bigger budget to vouch from, ask an owner of this community.'),
    setBudgetTo: word('Set budget to: {level}'),
    setBudgetToTitle: word('Set budget to'),
    vouchers: word('Vouchers'),
    makeSomeoneVoucher: word('+ Make someone a voucher'),
    makeSomeoneVoucherHelp: word('Make vouchers on the names list in the phone app.'),
    pastMax: word('Your vouches for @{name} can’t go past {max} Beans.'),
    seeWhoTheyBroughtIn: word('See who they brought in'),
    theirBudget: word('Their budget'),
    budgetHistoryCount: word('Budget history ({count})'),
    seeWhoTheyBroughtInCount: word('See who they brought in ({count})'),
    decreaseBudget: word('Decrease budget'),
    increaseBudget: word('Increase budget'),
    voucherCardSections: word('Voucher card sections'),
    vouchersRowText: word('{left} of {total} left · {vouched} vouched · {below} below zero'),
    vouchersRowTextNoLimit: word('No limit · {vouched} vouched · {below} below zero'),
    hasNotVouchedAnyone: word('Has not vouched for anyone yet.'),
    noBudgetHistoryYet: word('No budget history yet.'),
    raiseConfirmQuestion: word('You vouched {prior} for @{name} before. Raise it to {newTotal}?'),
    raise: word('Raise'),
    raiseTitle: word('Raise vouch?'),
    tradingWithOthers: word('trading with others'),
    tradingInsideOnly: word('trading inside only'),
    noTradesYet: word('no trades yet'),
    grantBy: word('+{amount} budget, made a voucher by @{name}'),
    grant: word('+{amount} budget, made a voucher'),
    topUpBy: word('+{amount} top-up by @{name}'),
    topUp: word('+{amount} top-up'),
    lowerBy: word('−{amount} budget lowered by @{name}'),
    lower: word('−{amount} budget lowered'),
    vouchedFor: word('−{amount} vouched for @{name}'),
    heldForInvite: word('−{amount} held for an invite'),
    backInviteExpired: word('+{amount} back, invite expired'),
    backBudgetStopped: word('+{amount} back, budget stopped'),
    backInviteRevoked: word('+{amount} back, invite revoked'),
    backNotLanded: word('+{amount} back, invite not landed'),
    backToBudget: word('+{amount} back to budget'),
    stopBy: word('−{amount} budget stopped by @{name}'),
    stop: word('−{amount} budget stopped'),
} as const;

export const vouchPresets = {
    label: VOUCH_PRESET_WORDS.label,
    none: VOUCH_PRESET_WORDS.none,
    fromBudget: VOUCH_PRESET_WORDS.fromBudget,
    fromBudgetNoLimit: VOUCH_PRESET_WORDS.fromBudgetNoLimit,
    notEnough: VOUCH_PRESET_WORDS.notEnough,
    pastMax: VOUCH_PRESET_WORDS.pastMax,
    noneLeft: VOUCH_PRESET_WORDS.noneLeft,
    notAVoucher: VOUCH_PRESET_WORDS.notAVoucher,
    beans: VOUCH_PRESET_WORDS.beans,
    noOfflineVouch: VOUCH_PRESET_WORDS.noOfflineVouch,
} as const;

/**
 * The two boxes the owners' and admins' invite form shows under the vouch presets (DESIGN-invites-and-names-list-amend3-fable.md
 * §1 and §4). The phone's form draws them live (slice A2). The web app holds no names-list key, so until the web list is built
 * (Marty, 8 Nov, Q2: phone first) it draws both switched off (slice A3), and a tap on either says `doneInApp` beside the row
 * (Marty, 9 Nov: a circle with a line through it said nothing).
 */
export const INVITE_ADDS_WORDS = {
    addToNames: word('Add them to the names list'),
    makeVoucher: word('Make them a voucher'),
    doneInApp: word('Adding someone to the names list, and making them a voucher, is done in the BeanPool app on your phone.'),
} as const;

export const ledger = {
    vouchedBy: VOUCH_PRESET_WORDS.ledgerVouchedBy,
    budget: VOUCH_PRESET_WORDS.ledgerBudget,
    budgetNoLimit: VOUCH_PRESET_WORDS.ledgerBudgetNoLimit,
} as const;

export const vouchFor = (name: string) => t(VOUCH_PRESET_WORDS.vouchFor, { name });
export const raiseVouchFor = (name: string) => t(VOUCH_PRESET_WORDS.raiseVouchFor, { name });
export const invitedBy = (name: string) => t(VOUCH_PRESET_WORDS.invitedBy, { name });
export const ledgerVouchedBy = (name: string) => t(VOUCH_PRESET_WORDS.ledgerVouchedBy, { name });
/**
 * The Ledger's one line for a member's vouches (GET /api/ledger/balance `vouchedBy`, one row per voucher, oldest first):
 * "Your credit line: 200, vouched by @marty"; with more than one voucher, the total once and each voucher's part,
 * "Your credit line: 300 · vouched by @marty 200, @olive 100". Null when nobody vouched. Never one "Your credit line" per
 * voucher: two of those read as two different lines, neither of them the whole.
 */
export function ledgerCreditLine(vouchedBy: readonly { callsign: string; amount: number }[] | null | undefined): string | null {
    const rows = (vouchedBy ?? []).filter((v) => v && typeof v.amount === 'number' && Number.isFinite(v.amount));
    if (rows.length === 0) return null;
    if (rows.length === 1) return t(VOUCH_PRESET_WORDS.ledgerCreditLine, { name: rows[0].callsign, amount: formatNumber(rows[0].amount) });
    const items = rows.map((v) => t(VOUCH_PRESET_WORDS.ledgerCreditLineVoucher, { name: v.callsign, amount: formatNumber(v.amount) }));
    const vouchers = items.slice(1).reduce((list, item) => t(VOUCH_PRESET_WORDS.ledgerCreditLineList, { list, item }), items[0]);
    // Summed in hundredths, so 0.1 + 0.2 reads 0.3.
    const total = rows.reduce((sum, v) => sum + Math.round(v.amount * 100), 0) / 100;
    return t(VOUCH_PRESET_WORDS.ledgerCreditLineMany, { total: formatNumber(total), vouchers });
}
export const ledgerBudget = (left: number, total: number) =>
    t(VOUCH_PRESET_WORDS.ledgerBudget, { left: formatNumber(left), total: formatNumber(total) });

/**
 * Whether the vouch control shows on an invite: only when the node says this member is a voucher.
 */
export function offersInviteVouch(voucher?: boolean | null): boolean {
    return voucher === true;
}

export interface HistoryLineLike {
    kind: string;
    amount: number;
    actor?: string;
    actorCallsign?: string | null;
    at?: string;
    for?: 'invite' | 'profile';
    why?: 'expired' | 'stopped' | 'not_landed' | 'revoked';
    outcome?: 'held' | 'vouched' | 'back';
    person?: { memberPubkey: string; callsign: string } | null;
}

/**
 * Format a budget history line into plain words without raw enums or 64-hex keys (design §3).
 */
export function formatHistoryLine(h: HistoryLineLike): string {
    const absAmount = formatNumber(Math.abs(h.amount));
    const name = h.actorCallsign || '';
    const personName = h.person?.callsign || '';

    switch (h.kind) {
        case 'grant':
            return name
                ? t(VOUCH_PRESET_WORDS.grantBy, { amount: absAmount, name })
                : t(VOUCH_PRESET_WORDS.grant, { amount: absAmount });
        case 'top_up':
            return name
                ? t(VOUCH_PRESET_WORDS.topUpBy, { amount: absAmount, name })
                : t(VOUCH_PRESET_WORDS.topUp, { amount: absAmount });
        case 'lower':
            return name
                ? t(VOUCH_PRESET_WORDS.lowerBy, { amount: absAmount, name })
                : t(VOUCH_PRESET_WORDS.lower, { amount: absAmount });
        case 'hold':
            if (personName) {
                return t(VOUCH_PRESET_WORDS.vouchedFor, { amount: absAmount, name: personName });
            }
            return t(VOUCH_PRESET_WORDS.heldForInvite, { amount: absAmount });
        case 'return':
            if (h.why === 'expired') {
                return t(VOUCH_PRESET_WORDS.backInviteExpired, { amount: absAmount });
            }
            if (h.why === 'stopped') {
                return t(VOUCH_PRESET_WORDS.backBudgetStopped, { amount: absAmount });
            }
            if (h.why === 'revoked') {
                return t(VOUCH_PRESET_WORDS.backInviteRevoked, { amount: absAmount });
            }
            if (h.why === 'not_landed') {
                return t(VOUCH_PRESET_WORDS.backNotLanded, { amount: absAmount });
            }
            return t(VOUCH_PRESET_WORDS.backToBudget, { amount: absAmount });
        case 'stop':
            return name
                ? t(VOUCH_PRESET_WORDS.stopBy, { amount: absAmount, name })
                : t(VOUCH_PRESET_WORDS.stop, { amount: absAmount });
        default:
            return t(VOUCH_PRESET_WORDS.beans, { amount: `${h.amount >= 0 ? '+' : '−'}${absAmount}` });
    }
}

