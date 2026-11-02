/**
 * Words for "From joining to a first trade", on the owners' Community health panel (apps/manager; the numbers are
 * apps/server engine/time-to-first-trade.ts). A number the node holds back reads as `tooFew`, never as 0.
 */
import { word, wordn } from './words.js';

export const FIRST_TRADE_WORDS = {
    title: word('From joining to a first trade'),
    intro: word("How far new members get, for this community's owners and admins only. Whole-community numbers: no names, and nothing about one person."),
    typical: word('Typical means the middle person: half were quicker, half slower.'),
    smallGroup: word('A typical time needs at least {n} people, or it shows as too few.'),
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
    tooFew: word('Too few yet to show'),
    noTrades: word('No trades yet'),
    underADay: word('Under a day'),
    beansOff: word('This community has no Beans, so there are no trades to measure.'),
    days: wordn('{n} day', '{n} days'),
} as const;
