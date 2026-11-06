/**
 * Words for "From joining to a first trade", on the owners' Community health panel (apps/manager; the numbers are
 * apps/server engine/time-to-first-trade.ts). A number the node holds back reads as `heldBack`, never as 0.
 */
import { word, wordn } from './words.js';

export const FIRST_TRADE_WORDS = {
    title: word('From joining to a first trade'),
    intro: word("How far new members get, for this community's owners and admins only. Whole-community numbers: no names, and nothing about one person."),
    typical: word('Typical means the middle person: half were quicker, half slower.'),
    smallGroup: word('A figure is held back when fewer than {n} people are behind it, or fewer than {n} people separate the two columns.'),
    listedFirst: word('The wait for a first trade counts only people who listed before they traded.'),
    steps: word('First trades go up in steps of {n}, so the number never points at one person.'),
    last90Days: word('Last 90 days'),
    allTime: word('All time'),
    joined: word('Joined'),
    firstListing: word('Made a first listing'),
    firstTrade: word('Completed a first trade'),
    atLeast: word('At least {n}'),
    toListing: word('Typical time from joining to a first listing'),
    listingToTrade: word('Typical time from a first listing to a first trade'),
    heldBack: word('Held back'),
    noTrades: word('No trades yet'),
    underADay: word('Under a day'),
    beansOff: word('This community has no Beans, so there are no trades to measure.'),
    days: wordn('{n} day', '{n} days'),
} as const;

/**
 * Words for "Needs this month", the block beside it on the same panel (cold start N4; apps/server engine/needs-this-month.ts).
 * A figure the node holds back reads `W.heldBack`, as in the rows above, never as 0.
 */
export const NEEDS_COUNT_WORDS = {
    title: word('Needs this month'),
    posted: word('Needs posted'),
    answered: word('Answered within a week'),
    definition: word('A Need is answered when someone other than the person who asked puts in a request on it, whatever came of the request. A Need still in its first week with no answer yet counts as posted only.'),
    steps: word('Answers go up in steps of {n}, and a figure under {n} is held back, so the number never points at one person.'),
} as const;
