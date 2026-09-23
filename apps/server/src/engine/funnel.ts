// Onboarding funnel — how many people try to join, and where they stop.
//
// Two kinds of number live here, deliberately:
//
//   Counted   things the node cannot reconstruct afterwards. A rejected invite code
//             leaves no row behind, so if we do not count it as it happens it is gone.
//   Derived   things already recorded elsewhere — a member's join date, their first
//             post — computed from those tables on read.
//
// Deriving wherever possible is not just tidiness. It means those steps carry their
// FULL history the day this ships instead of starting empty, and it keeps behaviour
// the node can already see out of a second table that would then need keeping in step.
//
// Neither kind stores a public key. `(day, event, variant, count)` is the whole shape,
// so an operator can see that four people abandoned the protection screen and cannot
// see which four. That is decision M2 in docs/ONBOARDING.md, and it is the difference
// between a funnel and a surveillance log — one schema choice, made once, at the start.
//
// Per-node only (M1): nothing here is reported outward. `sync.ts` uses an explicit
// typed payload rather than enumerating tables, so `onboarding_funnel` will not
// replicate across federation or to a backup node unless somebody deliberately adds
// it. Do not add it.

import { isServableAvatarValue } from '@beanpool/core';
import { db } from '../db/db.js';

/** Steps the node cannot reconstruct later, so they are counted as they happen. */
export type CountedEvent =
    | 'invite_attempt'      // a code was submitted
    | 'invite_failed'       // ...and rejected — variant carries the reason
    | 'invite_reentry'      // ...or the submitter was already a member (not a rejection,
                            // and not a signup — kept off invite_failed so the dashboard's
                            // failure rate means what it says)
    | 'avatar_published'    // step 2 done — first avatar only, not later edits
    | 'protection_shown'    // step 3 drawn
    | 'protection_choice'   // step 3 answered — sub-type is sso|words|skip
    | 'guide_complete';     // step 4 done

// The three above are reported by the phone and the PWA, and since this change each client
// reports each of them at most ONCE per identity per node: those rows carry a variant of
// `once` or `once:<sub-type>` (see @beanpool/core's onboarding-funnel helpers). Rows without
// that marker are the older one-per-showing counts, which cannot be corrected after the
// fact — the node never kept the per-person trail that would let it — and which the
// operator's screen therefore ignores rather than silently mixing in.

/** Steps computed from tables that already hold the answer. */
export type DerivedEvent =
    | 'member_created'      // step 1 done — a local member row exists. The cohort's base.
    | 'cohort_photo'        // ...and that same member has a servable photo TODAY
    | 'cohort_posted'       // ...and that same member has posted locally at least once, ever
    | 'activated';          // first post authored on this node, whenever they joined

export interface FunnelRow {
    day: string;        // YYYY-MM-DD, UTC
    event: CountedEvent | DerivedEvent;
    variant: string;    // '' when the event has no sub-type
    count: number;
}

/** Counters older than this are pruned on read. Daily rows are tiny; this is generous. */
const RETENTION_DAYS = 180;

function utcDay(d = new Date()): string {
    return d.toISOString().slice(0, 10);
}

function dayNDaysAgo(days: number): string {
    return utcDay(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

/**
 * Increment one counter. Never throws: a funnel that breaks a join is worse than
 * no funnel, so every failure here is swallowed after being logged once.
 */
export function recordFunnelEvent(event: CountedEvent, variant = ''): void {
    try {
        db.prepare(`
            INSERT INTO onboarding_funnel (day, event, variant, count)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(day, event, variant) DO UPDATE SET count = count + 1
        `).run(utcDay(), event, variant);
    } catch (e) {
        console.error('funnel: failed to record', event, variant, e);
    }
}

/**
 * Does this member currently have no avatar? Answers the question `avatar_published`
 * depends on, and only that — the caller records the event itself, AFTER its write has
 * actually succeeded.
 *
 * Split that way on purpose. Asking has to happen before the write (afterwards there is
 * no way to tell a first avatar from a fifth edit) but counting has to happen after it,
 * or a failed profile update — a taken callsign, say, which is a common thing to hit on
 * this very step — books an avatar that was never saved, and books it again on every
 * retry.
 */
export function hasNoAvatarYet(publicKey: string): boolean {
    try {
        const row = db.prepare(
            'SELECT avatar_url FROM members WHERE public_key = ?'
        ).get(publicKey) as { avatar_url?: string | null } | undefined;
        return !!row && !row.avatar_url;
    } catch (e) {
        console.error('funnel: failed to check first avatar', e);
        return false;
    }
}

/**
 * What counts as somebody who joined this hub — used by BOTH derived queries, because
 * they must agree on it.
 *
 * `home_node_url IS NULL` is what makes a member local; a non-null value marks a
 * federation visitor belonging to a peer node, and without the filter every visiting
 * trader lands in this hub's join funnel. The genesis row goes too — an operator
 * seeding themselves is not an onboarding event.
 *
 * Shared rather than written twice: the genesis clause was originally on the signup
 * query and missing from the activation one, so the operator's first post counted as a
 * new member getting started. Two copies of a predicate drift; one cannot.
 */
const JOINED_HERE = `m.home_node_url IS NULL AND COALESCE(m.invite_code, '') != 'genesis'`;

/**
 * A stored avatar is long — a `data:` URI can be megabytes — and the cohort query reads one
 * per member. Only the START of the value decides whether it is a real photo: the rule is
 * "non-empty, and not one of our own `/api/avatar/…` URLs round-tripped back to us", and
 * both of those tests are anchored at the beginning of the string. So SQL trims and hands
 * back a short prefix, and the ONE helper that owns the rule (@beanpool/core, shared with
 * every emission site) decides on that. Reading whole avatars to look at their first forty
 * characters would make an operator opening this panel load the node's entire photo library
 * into memory.
 */
const AVATAR_PREFIX_CHARS = 256;

interface CohortMemberRow {
    day: string;
    avatarHead: string | null;
    posted: number;
}

/**
 * THE COHORT: the people who joined here inside the window, and how far those same people
 * have since got.
 *
 * All three numbers come from ONE pass over one predicate, which is the whole point. The
 * screen's percentages are shares of "Joined", so if the rows could disagree about who is
 * in the group the percentages would be meaningless — and disagreeing is exactly what the
 * old screen did, counting joins over one span and photos over another and putting them in
 * the same column. Here "has a photo" and "has posted" are literally filtered subsets of
 * the members counted as "joined", row by row, so they cannot exceed it.
 *
 * Both follow-up questions are asked about NOW, not about the window: "does this person
 * have a photo today", "has this person ever posted". That is what an operator is actually
 * asking of a cohort — of the people who arrived in September, how many are really here —
 * and it is why someone who joined before the window is absent even if they posted inside
 * it. A cohort is a group of people, not a span of activity.
 *
 * Aggregate out, per M2: the rows read here carry a join day, an avatar prefix and a
 * yes/no, and are reduced to counts inside this function. No public key is selected.
 */
function derivedCohort(since: string): FunnelRow[] {
    const rows = db.prepare(`
        SELECT date(m.joined_at) AS day,
               substr(trim(COALESCE(m.avatar_url, '')), 1, ${AVATAR_PREFIX_CHARS}) AS avatarHead,
               EXISTS (
                   SELECT 1 FROM posts p
                   WHERE p.author_pubkey = m.public_key AND p.origin_node IS NULL
               ) AS posted
        FROM members m
        WHERE ${JOINED_HERE}
          AND m.joined_at >= ?
    `).all(since) as CohortMemberRow[];

    const perDay = new Map<string, { joined: number; photo: number; posted: number }>();
    for (const r of rows) {
        const day = r.day;
        if (!day) continue;
        const bucket = perDay.get(day) ?? { joined: 0, photo: 0, posted: 0 };
        bucket.joined++;
        if (isServableAvatarValue(r.avatarHead)) bucket.photo++;
        if (r.posted) bucket.posted++;
        perDay.set(day, bucket);
    }

    const out: FunnelRow[] = [];
    for (const [day, b] of perDay) {
        out.push({ day, event: 'member_created', variant: '', count: b.joined });
        // Zero-count rows are omitted, not emitted as 0: every other producer here reports
        // only what happened, and `getFunnel`'s callers already read a missing row as none.
        if (b.photo > 0) out.push({ day, event: 'cohort_photo', variant: '', count: b.photo });
        if (b.posted > 0) out.push({ day, event: 'cohort_posted', variant: '', count: b.posted });
    }
    return out;
}

/**
 * The day each local member first posted, counted per day.
 *
 * NOT the cohort's "has posted" row, and no longer what the operator's screen shows as
 * getting started. This is activity dated by the POST — it includes someone who joined two
 * years ago and finally listed something last week, which is a real and useful number but
 * is not a fact about the people who joined in this window. `cohort_posted` is that, dated
 * by the JOIN day. Both are kept because they answer different questions; the screen is
 * explicit about which one it is showing.
 *
 * Listing an offer is the act that opens the app up — under the trust model you must
 * have listed one before you can post a Need — so first post is the honest activation
 * signal. `origin_node IS NULL` keeps federated listings out. Trades could be folded
 * in later; one table is enough to answer "did they ever actually start".
 *
 * Being a MIN() per member, this is naturally idempotent — there is no "have we
 * counted this person yet" flag to keep, which is what lets activation stay derived
 * rather than needing a per-member row that M2 rules out.
 */
function derivedActivated(since: string): FunnelRow[] {
    const rows = db.prepare(`
        SELECT date(first_post) AS day, COUNT(*) AS count
        FROM (
            SELECT p.author_pubkey, MIN(p.created_at) AS first_post
            FROM posts p
            JOIN members m ON m.public_key = p.author_pubkey
            WHERE p.origin_node IS NULL
              AND ${JOINED_HERE}
            GROUP BY p.author_pubkey
        )
        WHERE first_post >= ?
        GROUP BY day
    `).all(since) as { day: string; count: number }[];
    return rows.map(r => ({ day: r.day, event: 'activated' as const, variant: '', count: r.count }));
}

/**
 * Drop counters past the retention window.
 *
 * Deliberately NOT called from getFunnel. A DELETE takes a write lock, and putting one
 * behind a read is both a contention risk and a way to lose data: asking for a year of
 * history would have pruned everything past 180 days and then returned the truncated
 * answer as if that were all there had ever been.
 *
 * Called once at startup instead. Precision does not matter here — these are daily
 * counter rows, a few dozen a day, so even a node left up for a year holds a few
 * thousand of them and a missed prune costs nothing.
 */
export function pruneFunnel(): void {
    try {
        db.prepare('DELETE FROM onboarding_funnel WHERE day < ?').run(dayNDaysAgo(RETENTION_DAYS));
    } catch (e) {
        console.error('funnel: prune failed', e);
    }
}

/** Widest window the endpoint will answer. Beyond retention there is nothing to find. */
const MAX_DAYS = 365;

/**
 * Coerce a caller-supplied window into a sane one.
 *
 * `days` ends up in a date comparison that drives a group-by over `posts`, so an
 * unbounded or junk value would let an admin-authenticated caller ask for an arbitrarily
 * wide scan — or, with a NaN, one whose SQL predicate quietly matches nothing and reads
 * as "no onboarding activity" rather than as an error.
 */
export function clampDays(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 30;
    return Math.min(MAX_DAYS, Math.max(1, Math.floor(n)));
}

/**
 * The whole funnel for the last `days` days: stored counters plus the derived steps,
 * sorted by day then event. Read-only. Derived rows arrive with full history already in
 * them, which is why this is useful on the day it ships rather than a fortnight later.
 */
export function getFunnel(days = 30): FunnelRow[] {
    const since = dayNDaysAgo(days);

    const counted = db.prepare(`
        SELECT day, event, variant, count
        FROM onboarding_funnel
        WHERE day >= ?
    `).all(since) as FunnelRow[];

    return [...counted, ...derivedCohort(since), ...derivedActivated(since)]
        .sort((a, b) => a.day.localeCompare(b.day) || a.event.localeCompare(b.event));
}
