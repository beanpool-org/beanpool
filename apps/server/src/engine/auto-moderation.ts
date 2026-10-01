/**
 * Auto-hide and auto-mute (global profile G3, design §2.5; D3 = a, Marty 2026-09-24): what the lobby does on its own
 * so nothing has to wait for a human, and what a moderator undoes. Local communities keep exactly today's
 * behaviour: both are off there (`autoHideReports`, `autoMute`), so nothing below ever writes on a local node, and
 * a report only reaches the queue.
 *
 * ## Auto-hide
 *
 * A post is hidden when reporters from 3 INDEPENDENT circles count towards it (`hideTally`). A reporter counts when
 * their report is open and, at the time it is weighed:
 *   - they are an active member, not the post's author, and were a member for at least 7 days when they reported it;
 *   - their standing (`standingOf`) is at least half its author's, rounded up. Standing is points read from rows, never
 *     a tier (tiers are merit badges and gate nothing): one per full week as a member, up to 26; one per kept post, up
 *     to 3; one per person they finished a deal with, up to 3. So three accounts a week old, however many posts they
 *     made, can hide a newcomer's post and not an established member's: those reports wait for the moderators. This
 *     is also what stops a ring from pushing an established member back onto probation (engine/probation.ts counts a
 *     post hidden by reports as not kept): it can't hide their posts in the first place;
 *   - a moderator has not already answered them on this post (a dismissed report, 'reviewed', means "looked at, and
 *     kept", so after a moderator keeps a post only NEW reporters can hide it again);
 *   - a moderator has not kept 3 or more of the posts they reported in the last 30 days (dismissed their report on a
 *     post that is still up): a reporter the moderators keep overruling stops counting, everywhere, for a while.
 * Reporters who count are then grouped into circles, and each circle counts once, however many of them reported:
 *   - the same connection: they joined through the open door from one internet address (an IPv6 /64) within 24 hours
 *     of each other (`open_joins.join_cohort`, a random label given at the join: engine/open-join.ts JOIN_COHORT_HOURS).
 *     Chained: a third who joined within a day of the second is in it too;
 *   - one sign-in's invites: they came in on invites traced back to the same member, however long ago (an invite
 *     needs no sign-in, so a tree of them is one person's however slowly it grew). The trace stops at a member who
 *     holds a node role (owner, admin, moderator): the community trusted them to let each person in.
 * It gets `posts.hidden_by_reports_at`. It is not removed: its row is untouched otherwise, its author still sees it,
 * and so do the moderators (owners, admins, moderators); for everyone else it drops out of every listing, search, map
 * read and count (packages/beanpool-engine posts.ts), and a phone that already holds it is told to drop it by its next
 * sync. The author hears, with the reason "reports". Its reports stay open in the moderators' queue, marked as on a
 * hidden post, until a moderator keeps it or takes it down. A report that doesn't count still reaches the queue, as
 * every report does. A report of a member, a Pulse item or an enterprise never hides anything.
 *
 * A moderator undoes it by restoring the post (`restoreHiddenPost`: every open report on it is dismissed, its
 * reporters are told it was kept), or by dismissing reports one at a time until what hid it no longer adds up
 * (`recheckHiddenPost`, weighed again as above). Removing it works as it always has.
 *
 * ## Auto-mute
 *
 * A member whose posts a moderator removed 3 times within 30 days gets `members.moderation_muted_until` set to
 * MUTED_UNTIL_LIFTED (far future: until a moderator lifts it). While muted they can't post, edit a post, or send
 * or start a message (403 `moderation_muted`); they can still read, edit their profile and leave. Lifting writes
 * the time of the lift over it, so the value is: NULL never muted, in the future muted, in the past lifted then;
 * only removals after a lift count towards the next mute. The stale-post prune is tidying, not a takedown, and is
 * never counted (`posts.removed_by_moderator_at` is written by the one-post removals only).
 *
 * The switches decide whether anything NEW is hidden or muted. A post already hidden, or a member already muted,
 * stays so until a moderator acts, whatever the switch says later: a switch turned off is not a review.
 */
import { isMemberKeySpelling } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { bumpActivityVersion, bumpMembersVersion, bumpPostsVersion } from './versions.js';
import { nodeRoleOf } from './node-roles.js';
import {
    notifyPostHidden, notifyPostBack, notifyMuted, notifyUnmuted, notifyReportDismissed, mutedBody,
    type ModerationNoticeCallbacks,
} from './moderation-notices.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const AUTO_HIDE = {
    /** Independent circles of reporters who count, to hide a post. */
    circles: 3,
    /** A reporter was a member for at least this long when they reported it. */
    reporterMinAgeDays: 7,
    /** A reporter's standing is at least this share of the author's, rounded up. */
    reporterShareOfAuthor: 0.5,
    /** A reporter whose reports on this many posts still up a moderator kept... */
    keptReportsToStopCounting: 3,
    /** ...within this many days stops counting towards any hide. */
    keptReportsWindowDays: 30,
} as const;

/** Standing, in points (see the file header). Never a tier. */
export const STANDING = { maxWeeks: 26, maxKeptPosts: 3, maxTradePartners: 3 } as const;
export const AUTO_MUTE = { removals: 3, windowDays: 30 } as const;
/** Muted until a moderator lifts it. */
export const MUTED_UNTIL_LIFTED = '9999-12-31T23:59:59.999Z';

const iso = (ms: number) => new Date(ms).toISOString();

interface PostForModeration { id: string; title: string | null; author_pubkey: string | null; active: number; status: string; hidden_by_reports_at: string | null }

function postRow(postId: string): PostForModeration | undefined {
    return db.prepare('SELECT id, title, author_pubkey, active, status, hidden_by_reports_at FROM posts WHERE id = ?')
        .get(postId) as PostForModeration | undefined;
}

const forNotice = (p: PostForModeration) => ({ id: p.id, title: p.title, authorPubkey: p.author_pubkey });

/** Still up: not taken down by its author or a moderator. Only then is "your post is back" true. */
const isLive = (p: PostForModeration) => p.active === 1 && p.status !== 'cancelled';

export function isHiddenByReports(postId: string): boolean {
    return !!postRow(postId)?.hidden_by_reports_at;
}

const WEEK_MS = 7 * DAY_MS;

/** Whole weeks as a member at `now`, up to the cap. A join time that can't be read proves nothing: 0. */
function weekPoints(joinedAt: string | null | undefined, now: number): number {
    const joined = joinedAt ? Date.parse(joinedAt) : NaN;
    if (!Number.isFinite(joined) || now <= joined) return 0;
    return Math.min(STANDING.maxWeeks, Math.floor((now - joined) / WEEK_MS));
}

/**
 * Kept posts, up to the cap: written here, not removed by a moderator, not hidden by reports (as probation counts
 * them). `countingPost` counts as kept even while hidden: an author's standing is weighed as it was before the hide,
 * so a hide never lowers the bar that keeps it.
 */
function keptPostPoints(pubkey: string, countingPost: string | null): number {
    return (db.prepare(
        `SELECT COUNT(*) AS c FROM (SELECT 1 FROM posts
           WHERE author_pubkey = ? AND origin_node IS NULL AND removed_by_moderator_at IS NULL
             AND (hidden_by_reports_at IS NULL OR id IS ?) LIMIT ?)`
    ).get(pubkey, countingPost, STANDING.maxKeptPosts) as { c: number }).c;
}

/** People they finished a deal with (a completed trade, either side), up to the cap. */
function tradePartnerPoints(pubkey: string): number {
    return (db.prepare(
        `SELECT COUNT(*) AS c FROM (
            SELECT seller_pubkey AS other FROM marketplace_transactions WHERE buyer_pubkey = ? AND status = 'completed'
            UNION
            SELECT buyer_pubkey AS other FROM marketplace_transactions WHERE seller_pubkey = ? AND status = 'completed'
            LIMIT ?)`
    ).get(pubkey, pubkey, STANDING.maxTradePartners) as { c: number }).c;
}

/**
 * A member's standing at `now`, in points: one per full week as a member (up to 26), one per kept post (up to 3), one
 * per person they finished a deal with (up to 3). From rows only, never a tier. 0 for a key that is not a member here.
 */
export function standingOf(pubkey: string, now: number = Date.now(), opts: { countingPost?: string | null } = {}): number {
    const row = db.prepare('SELECT joined_at FROM members WHERE public_key = ?').get(pubkey) as { joined_at: string | null } | undefined;
    if (!row) return 0;
    return weekPoints(row.joined_at, now) + keptPostPoints(pubkey, opts.countingPost ?? null) + tradePartnerPoints(pubkey);
}

export interface StandingParts { weeks: number; keptPosts: number; dealPartners: number; total: number }

/** `standingOf`, with what it is made of, for the moderators' screens (engine/burst-cleanup.ts). */
export function standingParts(pubkey: string, now: number = Date.now()): StandingParts {
    const row = db.prepare('SELECT joined_at FROM members WHERE public_key = ?').get(pubkey) as { joined_at: string | null } | undefined;
    if (!row) return { weeks: 0, keptPosts: 0, dealPartners: 0, total: 0 };
    const weeks = weekPoints(row.joined_at, now), keptPosts = keptPostPoints(pubkey, null), dealPartners = tradePartnerPoints(pubkey);
    return { weeks, keptPosts, dealPartners, total: weeks + keptPosts + dealPartners };
}

/** Whether a moderator kept enough of what this member reported lately that their reports no longer count. */
function keptReportsTooMany(pubkey: string, now: number): boolean {
    const since = iso(now - AUTO_HIDE.keptReportsWindowDays * DAY_MS);
    const row = db.prepare(
        `SELECT COUNT(*) AS c FROM (SELECT DISTINCT ar.target_post_id FROM abuse_reports ar
           JOIN posts p ON p.id = ar.target_post_id
          WHERE ar.reporter_pubkey = ? AND ar.status = 'reviewed' AND ar.updated_at > ?
            AND p.active = 1 AND p.status != 'cancelled'
          LIMIT ?)`
    ).get(pubkey, since, AUTO_HIDE.keptReportsToStopCounting) as { c: number };
    return row.c >= AUTO_HIDE.keptReportsToStopCounting;
}

/**
 * The member at the top of this member's invite tree: follow who invited whom up to someone who joined another way
 * (the open door, the genesis), whose inviter holds a node role, or whose inviter is not a member here. A member
 * nobody here invited is their own top.
 */
export function inviteTreeTop(pubkey: string, memo?: Map<string, string>): string {
    const known = memo?.get(pubkey);
    if (known) return known;
    const invitedBy = db.prepare('SELECT invited_by FROM members WHERE public_key = ?');
    const isMember = db.prepare("SELECT 1 FROM members WHERE public_key = ? AND COALESCE(is_treasury, 0) = 0");
    const seen = new Set<string>([pubkey]);
    const path: string[] = [pubkey];
    let top = pubkey;
    // To the real top, however deep: a loop (which no invite makes) ends at `seen`; a walk meeting a member whose top
    // is already known stops there. Every member passed gets the same top, so a tree costs one walk per call.
    for (;;) {
        const inviter = (invitedBy.get(top) as { invited_by: string | null } | undefined)?.invited_by;
        if (!inviter || !isMemberKeySpelling(inviter) || seen.has(inviter) || !isMember.get(inviter) || nodeRoleOf(inviter)) break;
        const inviterTop = memo?.get(inviter);
        if (inviterTop) { top = inviterTop; break; }
        seen.add(inviter);
        path.push(inviter);
        top = inviter;
    }
    if (memo) for (const k of path) memo.set(k, top);
    return top;
}

/** The label the open door gave this member's join, shared with everyone who joined from its address within a day. */
function joinCohortOf(pubkey: string): string | null {
    const row = db.prepare('SELECT join_cohort FROM open_joins WHERE member_pubkey = ?').get(pubkey) as { join_cohort: string | null } | undefined;
    return row?.join_cohort ?? null;
}

export interface HideTally {
    /** The author's standing, this post counted as kept. */
    authorStanding: number;
    /** The standing a reporter needs to count. */
    needed: number;
    /** The reporters who count, grouped into independent circles. */
    circles: string[][];
}

/** Who counts towards hiding this post, and in how many independent circles (the file header has the rule). */
export function hideTally(postId: string, now: number = Date.now()): HideTally {
    const post = postRow(postId);
    if (!post) return { authorStanding: 0, needed: 0, circles: [] };
    const authorStanding = post.author_pubkey ? standingOf(post.author_pubkey, now, { countingPost: postId }) : 0;
    const needed = Math.max(1, Math.ceil(authorStanding * AUTO_HIDE.reporterShareOfAuthor));
    const rows = db.prepare(
        `SELECT ar.reporter_pubkey AS reporter, MIN(ar.created_at) AS created_at, m.joined_at
           FROM abuse_reports ar
           JOIN members m ON m.public_key = ar.reporter_pubkey
          WHERE ar.target_post_id = ? AND (ar.status = 'pending' OR ar.status IS NULL)
            AND ar.reporter_pubkey IS NOT ? AND m.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM abuse_reports d
                             WHERE d.target_post_id = ar.target_post_id AND d.reporter_pubkey = ar.reporter_pubkey
                               AND d.status = 'reviewed')
          GROUP BY ar.reporter_pubkey
          ORDER BY MIN(ar.created_at)`
    ).all(postId, post.author_pubkey) as { reporter: string; created_at: string | null; joined_at: string | null }[];
    const minAge = AUTO_HIDE.reporterMinAgeDays * DAY_MS;
    const counting: string[] = [];
    for (const r of rows) {
        const joined = r.joined_at ? Date.parse(r.joined_at) : NaN;
        const reported = r.created_at ? Date.parse(r.created_at) : NaN;
        // A time that can't be read proves nothing about the reporter's age, so it does not count.
        if (!(Number.isFinite(joined) && Number.isFinite(reported) && reported - joined >= minAge)) continue;
        // Weeks first: when even full posts and deals could not reach the bar, nothing more is read.
        const weeks = weekPoints(r.joined_at, now);
        if (weeks + STANDING.maxKeptPosts + STANDING.maxTradePartners < needed) continue;
        if (weeks + keptPostPoints(r.reporter, null) + tradePartnerPoints(r.reporter) < needed) continue;
        if (keptReportsTooMany(r.reporter, now)) continue;
        counting.push(r.reporter);
    }
    // One circle per connected group: reporters sharing a door label or an invite tree, transitively.
    const parent = new Map<string, string>();
    const find = (k: string): string => {
        let x = k;
        while (parent.get(x) !== x) x = parent.get(x)!;
        parent.set(k, x);
        return x;
    };
    const link = (a: string, b: string) => {
        for (const k of [a, b]) if (!parent.has(k)) parent.set(k, k);
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(rb, ra);
    };
    const tops = new Map<string, string>();
    for (const r of counting) {
        link(`r:${r}`, `i:${inviteTreeTop(r, tops)}`);
        const cohort = joinCohortOf(r);
        if (cohort) link(`r:${r}`, `c:${cohort}`);
    }
    const byRoot = new Map<string, string[]>();
    for (const r of counting) {
        const root = find(`r:${r}`);
        byRoot.set(root, [...(byRoot.get(root) ?? []), r]);
    }
    return { authorStanding, needed, circles: [...byRoot.values()] };
}

/** Hidden or visible again: every copy anyone holds has to change, and the feed's post_created lines follow it. */
function announceVisibilityChange(cb: ModerationNoticeCallbacks, postId: string): void {
    bumpPostsVersion();
    bumpActivityVersion();
    // A doorbell, not the post: each app's catch-up sync then gets what it may see (the author and the moderators
    // the post, everyone else a removal), and a bare `{ type, id }` is never applied as a listing (livePostChange).
    try { cb.broadcast({ type: 'post_updated', id: postId }); } catch (e: any) { console.warn('[Moderation] Doorbell failed:', e?.message || e); }
}

/**
 * After a new report on a post: hide it when reporters from enough independent circles count towards it (the file
 * header). True when this call hid it. Does nothing where `autoHideReports` is off.
 */
export function evaluateAutoHide(cb: ModerationNoticeCallbacks, postId: string | null | undefined, now: number = Date.now()): boolean {
    if (!postId || !getProfileSwitches().autoHideReports) return false;
    const post = postRow(postId);
    if (!post || post.hidden_by_reports_at || post.active !== 1 || post.status === 'cancelled') return false;
    const tally = hideTally(postId, now);
    if (tally.circles.length < AUTO_HIDE.circles) return false;
    const at = iso(now);
    const res = db.prepare('UPDATE posts SET hidden_by_reports_at = ?, updated_at = ? WHERE id = ? AND hidden_by_reports_at IS NULL')
        .run(at, at, postId);
    if (res.changes === 0) return false;
    console.log(`🛡️ Post ${postId} hidden pending review: reporters in ${tally.circles.length} independent circles, each with standing ${tally.needed}+ (the author's is ${tally.authorStanding}).`);
    announceVisibilityChange(cb, postId);
    notifyPostHidden(cb, forNotice(post));
    return true;
}

/** Visible again. True when it was hidden. The reports are not touched here. */
function unhide(cb: ModerationNoticeCallbacks, post: PostForModeration, now: number): boolean {
    const at = iso(now);
    const res = db.prepare('UPDATE posts SET hidden_by_reports_at = NULL, updated_at = ? WHERE id = ? AND hidden_by_reports_at IS NOT NULL')
        .run(at, post.id);
    if (res.changes === 0) return false;
    announceVisibilityChange(cb, post.id);
    if (isLive(post)) notifyPostBack(cb, forNotice(post));
    return true;
}

/**
 * A moderator restores a hidden post: it is visible again, and every open report on it is dismissed, so each of
 * those reporters is told it was looked at and kept, and none of them can hide it again (only new reporters can).
 */
export function restoreHiddenPost(cb: ModerationNoticeCallbacks, postId: string, now: number = Date.now()): 'restored' | 'not_hidden' | 'not_found' {
    const post = postRow(postId);
    if (!post) return 'not_found';
    if (!post.hidden_by_reports_at) return 'not_hidden';
    let reporters: string[] = [];
    let restored = false;
    db.transaction(() => {
        const res = db.prepare('UPDATE posts SET hidden_by_reports_at = NULL, updated_at = ? WHERE id = ? AND hidden_by_reports_at IS NOT NULL')
            .run(iso(now), postId);
        if (res.changes === 0) return;
        restored = true;
        reporters = (db.prepare(
            `SELECT DISTINCT reporter_pubkey FROM abuse_reports WHERE target_post_id = ? AND (status = 'pending' OR status IS NULL)`
        ).all(postId) as { reporter_pubkey: string }[]).map(r => r.reporter_pubkey);
        db.prepare(
            `UPDATE abuse_reports SET status = 'reviewed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE target_post_id = ? AND (status = 'pending' OR status IS NULL)`
        ).run(postId);
    })();
    if (!restored) return 'not_hidden';
    console.log(`🛡️ Post ${postId} restored by a moderator; ${reporters.length} open report(s) on it dismissed.`);
    // The doorbell rings either way (the author's and the moderators' copies drop the hidden mark); the author hears
    // "it's back" only when it is still up, not after they or a moderator took it down.
    announceVisibilityChange(cb, postId);
    if (isLive(post)) notifyPostBack(cb, forNotice(post));
    for (const r of reporters) if (r !== post.author_pubkey) notifyReportDismissed(cb, r, postId, isLive(post));
    return 'restored';
}

/**
 * After a report on a post is dismissed: a hidden post whose remaining reports no longer add up to a hide is
 * visible again. True when this call un-hid it. Runs whatever the switch says: it only ever un-hides.
 */
export function recheckHiddenPost(cb: ModerationNoticeCallbacks, postId: string | null | undefined, now: number = Date.now()): boolean {
    if (!postId) return false;
    const post = postRow(postId);
    if (!post?.hidden_by_reports_at) return false;
    if (hideTally(postId, now).circles.length >= AUTO_HIDE.circles) return false;
    return unhide(cb, post, now);
}

// ── Auto-mute ──────────────────────────────────────────────────────────────────────────────────

/** A moderator took this post down (one post, not the stale-post prune): what auto-mute counts. */
export function recordModeratorRemoval(postId: string, now: number = Date.now()): void {
    const at = iso(now);
    db.prepare('UPDATE posts SET removed_by_moderator_at = ?, updated_at = ? WHERE id = ?').run(at, at, postId);
}

export interface MuteState { muted: boolean; until: string | null }

export function muteOf(pubkey: string, now: number = Date.now()): MuteState {
    const row = db.prepare('SELECT moderation_muted_until FROM members WHERE public_key = ?').get(pubkey) as { moderation_muted_until?: string | null } | undefined;
    const until = row?.moderation_muted_until ?? null;
    const ms = until ? Date.parse(until) : NaN;
    return Number.isFinite(ms) && ms > now ? { muted: true, until } : { muted: false, until: null };
}

export const MODERATION_MUTED = 'moderation_muted';

export class MutedError extends Error {
    readonly code = MODERATION_MUTED;
    readonly status = 403;
    constructor(readonly until: string | null) {
        super(mutedBody());
        this.name = 'MutedError';
    }
}

/** Before a post, an edit, or a message: throws MutedError while the member is muted. */
export function assertNotMuted(pubkey: string | null | undefined, now: number = Date.now()): void {
    if (!pubkey) return;
    const m = muteOf(pubkey, now);
    if (m.muted) throw new MutedError(m.until);
}

/**
 * One author's moderator removals since a time: what auto-mute counts, on every removal. Read through the partial
 * index idx_posts_author_removed (schema.sql), not a scan of every post; test-global-moderation checks the plan.
 */
export const REMOVALS_SINCE_SQL = 'SELECT COUNT(*) AS c FROM posts WHERE author_pubkey = ? AND removed_by_moderator_at > ?';

/**
 * After a moderator removed one of this member's posts: mute them when it is the 3rd within 30 days (since the last
 * lift, if later). True when this call muted them. Does nothing where `autoMute` is off.
 */
export function evaluateAutoMute(cb: ModerationNoticeCallbacks, authorPubkey: string | null | undefined, now: number = Date.now()): boolean {
    if (!authorPubkey || !getProfileSwitches().autoMute) return false;
    const row = db.prepare('SELECT moderation_muted_until FROM members WHERE public_key = ?').get(authorPubkey) as { moderation_muted_until?: string | null } | undefined;
    if (!row) return false;
    const current = row.moderation_muted_until ? Date.parse(row.moderation_muted_until) : NaN;
    if (Number.isFinite(current) && current > now) return false;
    const since = Math.max(now - AUTO_MUTE.windowDays * DAY_MS, Number.isFinite(current) ? current : -Infinity);
    const removals = (db.prepare(REMOVALS_SINCE_SQL).get(authorPubkey, iso(since)) as { c: number }).c;
    if (removals < AUTO_MUTE.removals) return false;
    db.prepare('UPDATE members SET moderation_muted_until = ?, updated_at = ? WHERE public_key = ?')
        .run(MUTED_UNTIL_LIFTED, iso(now), authorPubkey);
    bumpMembersVersion();
    console.log(`🛡️ Member ${authorPubkey.slice(0, 12)}… muted: ${removals} posts removed by moderators in ${AUTO_MUTE.windowDays} days.`);
    notifyMuted(cb, authorPubkey);
    return true;
}

/** A moderator lifts a mute. True when the member was muted. */
export function liftMute(cb: ModerationNoticeCallbacks, pubkey: string, now: number = Date.now()): boolean {
    if (!muteOf(pubkey, now).muted) return false;
    const at = iso(now);
    db.prepare('UPDATE members SET moderation_muted_until = ?, updated_at = ? WHERE public_key = ?').run(at, at, pubkey);
    bumpMembersVersion();
    notifyUnmuted(cb, pubkey);
    return true;
}

/** Everyone muted now, for the moderators' list. */
export function listMutedMembers(now: number = Date.now()): { publicKey: string; callsign: string | null; mutedUntil: string }[] {
    return (db.prepare(
        'SELECT public_key, callsign, moderation_muted_until FROM members WHERE moderation_muted_until > ? ORDER BY callsign'
    ).all(iso(now)) as { public_key: string; callsign: string | null; moderation_muted_until: string }[])
        .map(r => ({ publicKey: r.public_key, callsign: r.callsign, mutedUntil: r.moderation_muted_until }));
}
