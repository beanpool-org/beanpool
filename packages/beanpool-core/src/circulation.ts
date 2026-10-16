/**
 * Community Circulation (demurrage): the brackets a positive balance slowly returns to the Commons by, each month.
 *
 * ONE SOURCE. LedgerManager decays balances by these brackets, and the Wallet on the phone and on the web shows the
 * monthly figure from `monthlyCirculation()`; a screen never keeps its own copy (16 Oct 2026, PR #2020 fix round 1:
 * the web's and the phone's Wallets each carried a hand copy).
 *
 * Progressive, like a tax bracket: the first 200 Beans are free, the next 300 go at 1 % a month, and so on, so a
 * balance pays each rate only on the part that sits in that bracket.
 *
 * Pure: no I/O, no Node built-ins (the barrel is bundled for the phone, barrel-is-universal.test.ts).
 */

export interface CirculationBracket {
    /** How many Beans this bracket holds (Infinity for the last one). */
    readonly maxInBracket: number;
    /** The share of the Beans in this bracket that goes to the Commons each month. */
    readonly rate: number;
}

export const CIRCULATION_BRACKETS: readonly CirculationBracket[] = [
    { maxInBracket: 200, rate: 0.000 }, // 0 - 200 (Tax-free Green Zone)
    { maxInBracket: 300, rate: 0.010 }, // 200 - 500
    { maxInBracket: 500, rate: 0.015 }, // 500 - 1000
    { maxInBracket: 1000, rate: 0.020 }, // 1000 - 2000
    { maxInBracket: Infinity, rate: 0.025 }, // 2000+
];

/** A balance at or under this many Beans sends nothing to the Commons (the first bracket's size). */
export const CIRCULATION_FREE_BEANS = CIRCULATION_BRACKETS[0].maxInBracket;

/** The balance left after `monthsPassed` months of circulation (a fraction of a month decays by the same curve). */
export function balanceAfterCirculation(balance: number, monthsPassed: number): number {
    if (balance <= 0) return balance;

    let remainingBalance = balance;
    let newBalance = 0;

    for (const bracket of CIRCULATION_BRACKETS) {
        if (remainingBalance <= 0) break;

        const amountInBracket = Math.min(remainingBalance, bracket.maxInBracket);
        const decayedAmount = amountInBracket * Math.pow(1 - bracket.rate, monthsPassed);

        newBalance += decayedAmount;
        remainingBalance -= amountInBracket;
    }

    return newBalance;
}

/** The Beans that `balance` sends to the Commons over one month: 0 at or under CIRCULATION_FREE_BEANS. */
export function monthlyCirculation(balance: number): number {
    if (balance <= CIRCULATION_FREE_BEANS) return 0;
    return balance - balanceAfterCirculation(balance, 1);
}
