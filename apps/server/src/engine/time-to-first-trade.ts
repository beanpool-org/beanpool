/**
 * How long a new person takes to reach a first real trade (Marty and Damo, 2 Nov 2026: "just do number 1"). The measure only:
 * no Bean moves, nothing is stored, and no member is told anything. Owners and admins read it on the Community health panel
 * and through the assistant's `community_totals`; nothing public carries it. It goes out inside communityTotals
 * (engine/community-health.ts), whose other numbers are public by rule. These are not: they say what new members did.
 *
 * The people: everyone who joined here (engine/funnel.ts JOINED_HERE, so no federation visitor and no genesis operator), and
 * no visitor's row and no enterprise's. Each is read once, and what comes out is counts and medians: no key is selected, and
 * no name, date or member row leaves this file.
 *  - Removed, suspended or gone (status 'pruned', 'disabled'): still counted, with what they reached. They joined, and leaving
 *    them out would make a community that loses its new people look quicker than it is.
 *  - An account its owner closed (deleted_by_owner_at): the same. Its row and its posts' dates stay and hold no words, and
 *    taking it out would move the numbers on the day it closed, which says what that person had reached.
 *  - A re-keyed member is one person: key-move.ts moves the row, its listings and its deals to the new key.
 *
 * A first listing: the earliest Offer or Need the member made here by their own hand. An event or a poll isn't a listing.
 *  - A copy of a listing from elsewhere isn't one: not one held from a peer (origin_node), and not a member's copy on the
 *    global community (shown_from_host, set even on a copy its owner deleted).
 *  - An enterprise's listing is the listing of the keeper who made it (created_by): that keeper's own first step. The
 *    enterprise is not a person, and is not in the numbers.
 *  - A listing an owner's assistant made (created_via) doesn't count. Seeding is the owner's job of work, not a new person
 *    finding their way, and a seeding run would read as a first listing within minutes of joining.
 *  - A listing later cancelled, hidden or removed still counts: they made it. Its row is never deleted.
 *
 * A first trade: the earliest deal the member finished, buying or selling, with status 'completed' (escrow.ts: the buyer
 * confirmed, or an admin released or split a dispute). 'requested' and 'pending' aren't finished; 'rejected' and 'cancelled'
 * never happened, a dispute refunded to the buyer among them, and each of those carries a completed_at too, so the status is
 * what decides. A trade on a listing an assistant made counts: two people did it.
 *  - A deal on an enterprise's listing is a first trade for the person on the other side and for the keeper who made it.
 *  - A deal with an enterprise the member keeps is no trade: it is their own money going round (as escrow.ts's isBuyerKeeper).
 *
 * "First listing to first trade" reads only those who listed first. Someone who bought before they listed is in the trade
 * count and not in this median: their wait wasn't for a buyer.
 *
 * What small numbers would give away, and what this does about it. Owners and admins already see who joined and when, and
 * every member sees every listing, so `joined` and `firstListing` are exact: they tell nobody anything new. A trade is
 * different: "Admins never see anyone's trades".
 *  - No median of fewer than FIRST_TRADE_MIN_GROUP people, ever: "1 member, 3 days" is a person.
 *  - The first-trade count is shown in steps of 5, rounded down, so fewer than 5 reads the same as none. An exact count that
 *    moved by one would name someone: when one member ages out of the window, whether it falls says whether they had traded,
 *    and the admins can see who that was.
 *  - Two windows side by side: their difference is the people who joined before the window. Where that is 1 to 4 people, the
 *    last-90-days trade figures are hidden and all time stands alone, or those few people would be readable by subtraction.
 *    The same for a median whose two groups differ by 1 to 4.
 *  - A whole-day median, on a window that starts at a UTC midnight, so the answer doesn't creep within a day.
 * Left open, accepted: an admin who reads every day and knows when each member joined could, on the day one member ages out
 * of the 90 days, see a median move or a step fall, and infer that member was in it. A median can't be rounded out of that, and
 * only a window that stopped sliding would end it. It needs a daily habit, a small community and a median near a boundary,
 * and tells only that a first trade happened, not with whom or for how much.
 *
 * Cost, on a panel load and on the assistant's read: one pass over the members who joined here, with indexed lookups for each
 * (idx_posts_author_created_local, idx_posts_created_by, the deals' buyer and seller indexes, the post and status one, and
 * treasury_operators' key). Measured on a shared Mac, on a node of 300 members, 800 posts and 300 deals: 2 ms; of 30,000
 * members, 150,000 posts and 150,000 deals: 345 ms (max 424), on the one server thread. Nothing is stored or cached.
 */
import { db } from '../db/db.js';
import { getNodeFeatures } from '../config/node-profile.js';
import { parseDbTime } from '../decisions-engine.js';
import { JOINED_HERE } from './funnel.js';

/** Fewer people than this and nothing about what they did is shown. */
export const FIRST_TRADE_MIN_GROUP = 5;
export const FIRST_TRADE_WINDOW_DAYS = 90;

const DAY_MS = 86_400_000;

export interface FirstTradeWindow {
    joined: number;
    firstListing: number;
    /** At least this many, a multiple of 5. Null: too few yet to show (or Beans are off). 0 only where there has been no trade at all. */
    firstTrade: number | null;
    /** Median whole days from joining to a first listing. Null: too few yet to show. */
    daysToFirstListing: number | null;
    /** Median whole days from a first listing to a first trade. Null: too few yet to show, or nothing to measure. */
    daysFromListingToTrade: number | null;
}

export interface FirstTradeFunnel {
    /** False: this community has no Beans, so it has no trades to measure and `firstTrade` is null, never 0. */
    beans: boolean;
    /** False: not one trade has been finished here, which names nobody and reads plainly. */
    anyTrades: boolean;
    minGroup: number;
    last90Days: FirstTradeWindow;
    allTime: FirstTradeWindow;
}

interface Tally { joined: number; listed: number; traded: number; toListing: number[]; listingToTrade: number[] }
const tally = (): Tally => ({ joined: 0, listed: 0, traded: 0, toListing: [], listingToTrade: [] });

/** A member's own Offer or Need here: see the header. */
const OWN_LISTING = `p.type IN ('offer', 'need') AND p.origin_node IS NULL AND p.shown_from_host IS NULL AND p.created_via IS NULL`;
const COMPLETED_AT = 'COALESCE(t.completed_at, t.created_at)';
const KEEPS = (enterprise: string, member: string) => `EXISTS (SELECT 1 FROM treasury_operators o WHERE o.treasury_pubkey = ${enterprise} AND o.member_pubkey = ${member})`;

/**
 * One row per person who joined here: dates only, never a key. Each lookup by `created_by` names its index. Nearly every post
 * has none, and all those NULLs read as one huge value to ANALYZE, after which the planner drops the index and walks every post
 * once per member (measured at 300 members and 800 posts: 19 ms; at 30,000 and 150,000 it never finished).
 */
export const FIRST_TRADE_PEOPLE_SQL = `SELECT m.joined_at AS joined,
    (SELECT MIN(p.created_at) FROM posts p WHERE p.author_pubkey = m.public_key AND ${OWN_LISTING}) AS listed,
    (SELECT MIN(p.created_at) FROM posts p INDEXED BY idx_posts_created_by WHERE p.created_by = m.public_key AND ${OWN_LISTING}) AS listedForEnterprise,
    (SELECT MIN(${COMPLETED_AT}) FROM marketplace_transactions t WHERE t.buyer_pubkey = m.public_key AND t.status = 'completed'
        AND t.seller_pubkey != m.public_key AND NOT ${KEEPS('t.seller_pubkey', 'm.public_key')}) AS bought,
    (SELECT MIN(${COMPLETED_AT}) FROM marketplace_transactions t WHERE t.seller_pubkey = m.public_key AND t.status = 'completed'
        AND t.buyer_pubkey != m.public_key AND NOT ${KEEPS('t.buyer_pubkey', 'm.public_key')}) AS sold,
    (SELECT MIN(${COMPLETED_AT}) FROM posts p INDEXED BY idx_posts_created_by JOIN marketplace_transactions t ON t.post_id = p.id AND t.status = 'completed'
        WHERE p.created_by = m.public_key AND p.author_pubkey != m.public_key
          AND NOT ${KEEPS('p.author_pubkey', 't.buyer_pubkey')} AND NOT ${KEEPS('p.author_pubkey', 't.seller_pubkey')}) AS soldForEnterprise
    FROM members m
    WHERE ${JOINED_HERE} AND m.is_visitor = 0 AND m.is_treasury = 0`;

/** The earliest of these, or null. */
function earliest(...values: Array<string | null>): number | null {
    const times = values.map(parseDbTime).filter(Number.isFinite);
    return times.length ? Math.min(...times) : null;
}

function medianDays(spans: number[]): number {
    const sorted = [...spans].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return Math.round(median / DAY_MS);
}

/** Whether a group inside all time can be read beside it: the same people, or enough left over that no few can be subtracted. */
const apartFromAllTime = (here: number, allTime: number) => allTime === here || allTime - here >= FIRST_TRADE_MIN_GROUP;

function reading(here: Tally, all: Tally, beans: boolean, anyTrades: boolean): FirstTradeWindow {
    const median = (spans: number[], allSpans: number[], open = true) =>
        open && spans.length >= FIRST_TRADE_MIN_GROUP && apartFromAllTime(spans.length, allSpans.length) ? medianDays(spans) : null;
    const tradesCanShow = beans && anyTrades && apartFromAllTime(here.joined, all.joined);
    const stepped = here.traded - (here.traded % FIRST_TRADE_MIN_GROUP);
    return {
        joined: here.joined,
        firstListing: here.listed,
        firstTrade: beans && !anyTrades ? 0 : tradesCanShow && stepped > 0 ? stepped : null,
        daysToFirstListing: median(here.toListing, all.toListing),
        daysFromListingToTrade: median(here.listingToTrade, all.listingToTrade, tradesCanShow),
    };
}

/** The funnel of the people who joined here, the last 90 days and all time: counts and medians, for owners and admins only. */
export function firstTradeFunnel(now = new Date()): FirstTradeFunnel {
    const since = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - FIRST_TRADE_WINDOW_DAYS * DAY_MS;
    const all = tally();
    const recent = tally();
    for (const r of db.prepare(FIRST_TRADE_PEOPLE_SQL).iterate() as IterableIterator<Record<'joined' | 'listed' | 'listedForEnterprise' | 'bought' | 'sold' | 'soldForEnterprise', string | null>>) {
        const joined = parseDbTime(r.joined);
        if (!Number.isFinite(joined)) continue;
        const listed = earliest(r.listed, r.listedForEnterprise);
        const traded = earliest(r.bought, r.sold, r.soldForEnterprise);
        for (const t of joined >= since ? [all, recent] : [all]) {
            t.joined++;
            if (listed !== null) {
                t.listed++;
                t.toListing.push(Math.max(0, listed - joined));
            }
            if (traded !== null) {
                t.traded++;
                if (listed !== null && traded >= listed) t.listingToTrade.push(traded - listed);
            }
        }
    }
    const beans = getNodeFeatures().beans;
    const anyTrades = beans && !!db.prepare("SELECT 1 FROM marketplace_transactions WHERE status = 'completed' LIMIT 1").get();
    return {
        beans, anyTrades, minGroup: FIRST_TRADE_MIN_GROUP,
        last90Days: reading(recent, all, beans, anyTrades),
        allTime: reading(all, all, beans, anyTrades),
    };
}
