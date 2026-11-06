/**
 * How many Needs were asked this month and how many got an answer within a week (cold start N4; scratch/fable-design/
 * DESIGN-cold-start-trades-fable.md §2.4 "Owners' count" and §5). The measure only: no Bean moves, nothing is stored, and no
 * member is told anything. Owners and admins read it on the Community health panel and through the assistant's
 * `community_totals`, beside "From joining to a first trade" (engine/time-to-first-trade.ts); it goes out inside
 * communityTotals (engine/community-health.ts) and nothing public carries it. Counts only: no Need, no key, no name, no date.
 *
 * "This month": since the first of the month in UTC, the same month `tradesThisMonth` counts. A Need posted last month is not
 * counted this month, even if its answer came this month.
 *
 * Posted: a Need a member made here by their own hand, on the Market for everyone. A copy of a Need from elsewhere isn't one
 * (not one held from a peer, origin_node, and not a member's copy on the global community, shown_from_host), nor is one shown
 * only to a group or to one person, nor one an owner's assistant made (created_via): seeding is the owner's job of work, not a
 * neighbour asking. Cancelled, hidden or removed later still counts: someone asked, and its row is never deleted. The same
 * rule as a "first listing" in time-to-first-trade.ts. Every member can see every public Need, so this number is exact: it
 * tells nobody anything new.
 *
 * ANSWERED: THE FIRST ANSWER IS THE FIRST REQUEST. A Need is answered when anyone other than the person who asked, and other
 * than a keeper of the enterprise that asked, puts in a request on it: a row in marketplace_transactions on that Need whose
 * seller is the helper (escrow.ts requestPost: on a Need the helper is the seller and the asker the buyer). However it
 * ended (agreed, turned down, withdrawn, done) the neighbour answered. It is "within a week" when that first request came
 * no more than 7 days after the Need was posted. A Need still in its first week with no request yet is posted and not
 * answered (yet); the next read counts it if one comes in time. The panel's help line says the same.
 *
 * What a small number would give away, and what this does about it. Who answered which Need is between those two people (a
 * request is seen by the asker and the helper) and the panel says "Admins never see anyone's trades". `posted` is exact, as
 * above; `answeredWithinWeek` is not:
 *  - It goes up in steps of FIRST_TRADE_MIN_GROUP (5), rounded down, exactly as the first-trade count does, so fewer than 5
 *    reads the same as none: a Need answered in a month with one Need asked is not readable as that Need's. Held back
 *    (null) is never shown as 0, except where nothing was asked at all (posted 0, which says nothing new).
 *  - Where deals are off (`deals` false: Beans off, or escrow off) a Need cannot be answered here by a request, so the answered
 *    figure is null, never a 0 that would read as "nobody helps".
 * Left open, accepted, as for the first-trade count: an admin who reads every day could see the step appear on the day the
 * fifth answered Need makes it, and that tells that some Need was answered, not which, or by whom; and a month where every
 * Need that was asked was answered says so ("Needs posted 5, Answered within a week: At least 5").
 *
 * Cost, on a panel load and on the assistant's read: one pass over the month's Needs (type 'need', created_at since the first of
 * the month), and for each one an indexed look at its requests (idx_marketplace_transactions_post_status, post_id leading) and
 * at treasury_operators' key. posts has no index on type, so the pass reads the table once, as a month of Needs on a node is a
 * few dozen to a few hundred rows. Measured in test-needs-this-month.ts. Nothing is stored or cached.
 */
import { db } from '../db/db.js';
import { getNodeFeatures } from '../config/node-profile.js';
import { parseDbTime } from '../decisions-engine.js';
import { FIRST_TRADE_MIN_GROUP } from './time-to-first-trade.js';

/** "Within a week": the first request came no later than this many days after the Need was posted. */
export const NEEDS_ANSWER_DAYS = 7;

const DAY_MS = 86_400_000;

export interface NeedsThisMonth {
    /** False: this community has no deals (Beans or escrow off), so a Need can't be answered by a request and `answeredWithinWeek` is null, never 0. */
    deals: boolean;
    minGroup: number;
    /** Needs asked this month, exact. */
    posted: number;
    /** At least this many, a multiple of 5. Null: held back (under 5), or deals are off. 0 only where no Need was asked at all. */
    answeredWithinWeek: number | null;
}

/** A Need a member asked here by their own hand: see the header. */
export const OWN_NEED = `p.type = 'need' AND p.audience_scope = 'public' AND p.origin_node IS NULL AND p.shown_from_host IS NULL AND p.created_via IS NULL`;

export const NEEDS_POSTED_SQL = `SELECT p.id, p.author_pubkey AS author, p.created_at AS at FROM posts p WHERE ${OWN_NEED} AND p.created_at >= ?`;

/** A first request on a Need: from the helper (the seller on a Need), who is neither the asker nor a keeper of the enterprise that asked. */
export const NEEDS_REQUESTS_SQL = `SELECT t.created_at FROM marketplace_transactions t WHERE t.post_id = ? AND t.seller_pubkey != ?
    AND NOT EXISTS (SELECT 1 FROM treasury_operators o WHERE o.treasury_pubkey = ? AND o.member_pubkey = t.seller_pubkey)`;

/** The month's Needs and how many were answered in their first week: counts only, for owners and admins only. */
export function needsThisMonth(now = new Date()): NeedsThisMonth {
    const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    // The SQL bound is the day before, as text: any stored form of a time ('2026-11-01T…Z', SQLite's '2026-11-01 …', even one
    // with an offset) sorts after it if it is this month, and the exact instant is decided below, where the time is parsed.
    const since = new Date(monthStartMs - DAY_MS).toISOString().slice(0, 10);
    const needs = db.prepare(NEEDS_POSTED_SQL)
        .all(since) as Array<{ id: string; author: string; at: string }>;
    const requests = db.prepare(NEEDS_REQUESTS_SQL);
    const deals = getNodeFeatures().escrow;
    let posted = 0;
    let answered = 0;
    for (const need of needs) {
        const postedAt = parseDbTime(need.at);
        if (!Number.isFinite(postedAt) || postedAt < monthStartMs) continue;
        posted++;
        if (!deals) continue;
        const asked = (requests.all(need.id, need.author, need.author) as Array<{ created_at: string }>)
            .map(r => parseDbTime(r.created_at)).filter(Number.isFinite);
        if (asked.length && Math.min(...asked) - postedAt <= NEEDS_ANSWER_DAYS * DAY_MS) answered++;
    }
    const stepped = answered - (answered % FIRST_TRADE_MIN_GROUP);
    return {
        deals,
        minGroup: FIRST_TRADE_MIN_GROUP,
        posted,
        answeredWithinWeek: !deals ? null : posted === 0 ? 0 : stepped > 0 ? stepped : null,
    };
}
