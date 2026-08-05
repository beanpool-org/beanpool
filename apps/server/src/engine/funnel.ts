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

import { db } from '../db/db.js';

/** Steps the node cannot reconstruct later, so they are counted as they happen. */
export type CountedEvent =
    | 'invite_attempt'      // a code was submitted
    | 'invite_failed'       // ...and rejected — variant carries the reason
    | 'invite_reentry'      // ...or the submitter was already a member (not a rejection,
                            // and not a signup — kept off invite_failed so the dashboard's
                            // failure rate means what it says)
    | 'avatar_published'    // step 2 done — first avatar only, not later edits
    | 'protection_shown'    // step 3 drawn — variant is the keeper-count state A|B|C
    | 'protection_choice'   // step 3 answered — variant is sso|words|skip
    | 'guide_complete';     // step 4 done

/** Steps computed from tables that already hold the answer. */
export type DerivedEvent =
    | 'member_created'      // step 1 done — a local member row exists
    | 'activated';          // first post authored on this node

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
 * Fires `avatar_published` only on the transition from no avatar to having one, so
 * a member editing their photo for the third time does not read as a fresh signup.
 * Call BEFORE the update, with the avatar that is about to be written.
 */
export function recordFirstAvatar(publicKey: string, incomingAvatar: unknown): void {
    if (!incomingAvatar) return;
    try {
        const row = db.prepare(
            'SELECT avatar_url FROM members WHERE public_key = ?'
        ).get(publicKey) as { avatar_url?: string | null } | undefined;
        if (row && !row.avatar_url) recordFunnelEvent('avatar_published');
    } catch (e) {
        console.error('funnel: failed to check first avatar', e);
    }
}

/**
 * Members who joined HERE, per day.
 *
 * `home_node_url IS NULL` is what makes a member local — a non-null value marks a
 * federation visitor who belongs to a peer node. Without that filter every visiting
 * trader would land in this node's join funnel. The genesis row is excluded too: an
 * operator seeding themselves is not an onboarding event.
 */
function derivedMemberCreated(since: string): FunnelRow[] {
    const rows = db.prepare(`
        SELECT date(joined_at) AS day, COUNT(*) AS count
        FROM members
        WHERE home_node_url IS NULL
          AND COALESCE(invite_code, '') != 'genesis'
          AND joined_at >= ?
        GROUP BY day
    `).all(since) as { day: string; count: number }[];
    return rows.map(r => ({ day: r.day, event: 'member_created' as const, variant: '', count: r.count }));
}

/**
 * The day each local member first posted, counted per day.
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
              AND m.home_node_url IS NULL
            GROUP BY p.author_pubkey
        )
        WHERE first_post >= ?
        GROUP BY day
    `).all(since) as { day: string; count: number }[];
    return rows.map(r => ({ day: r.day, event: 'activated' as const, variant: '', count: r.count }));
}

/** Drop counters past the retention window. Cheap, and reads are rare. */
function prune(): void {
    try {
        db.prepare('DELETE FROM onboarding_funnel WHERE day < ?').run(dayNDaysAgo(RETENTION_DAYS));
    } catch (e) {
        console.error('funnel: prune failed', e);
    }
}

/**
 * The whole funnel for the last `days` days: stored counters plus the derived steps,
 * sorted by day then event. Derived rows arrive with full history already in them,
 * which is why this is useful on the day it ships rather than a fortnight later.
 */
export function getFunnel(days = 30): FunnelRow[] {
    prune();
    const since = dayNDaysAgo(days);

    const counted = db.prepare(`
        SELECT day, event, variant, count
        FROM onboarding_funnel
        WHERE day >= ?
    `).all(since) as FunnelRow[];

    return [...counted, ...derivedMemberCreated(since), ...derivedActivated(since)]
        .sort((a, b) => a.day.localeCompare(b.day) || a.event.localeCompare(b.event));
}
