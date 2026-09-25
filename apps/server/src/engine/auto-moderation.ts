/**
 * Auto-hide and auto-mute (global profile G3, design §2.5; D3 = a, Marty 2026-09-24): what the lobby does on its own
 * so nothing has to wait for a human, and what a moderator undoes. Local communities keep exactly today's
 * behaviour: both are off there (`autoHideReports`, `autoMute`), so nothing below ever writes on a local node, and
 * a report only reaches the queue.
 *
 * ## Auto-hide
 *
 * A post reported by 3 DISTINCT members, each a member for at least 7 days when they reported it (so a ring of fresh
 * accounts can't brigade), gets `posts.hidden_by_reports_at`. It is not removed: its row is untouched otherwise, its
 * author still sees it, and so do the moderators (owners, admins, moderators); for everyone else it drops out of
 * every listing, search, map read and count (packages/beanpool-engine posts.ts), and a phone that already holds it
 * is told to drop it by its next sync. The author hears, with the reason "reports". Only an open report counts,
 * never the post's own author, never a suspended account, and never a reporter a moderator has already answered on
 * this post: a dismissed report ('reviewed') means "looked at, and kept", so after a moderator keeps a post only
 * NEW reporters can hide it again. A report of a member, a Pulse item or an enterprise never hides anything.
 *
 * A moderator undoes it by restoring the post (`restoreHiddenPost`: every open report on it is dismissed, its
 * reporters are told it was kept), or by dismissing reports one at a time until what hid it no longer adds up
 * (`recheckHiddenPost`). Removing it works as it always has.
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
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { bumpActivityVersion, bumpMembersVersion, bumpPostsVersion } from './versions.js';
import {
    notifyPostHidden, notifyPostBack, notifyMuted, notifyUnmuted, notifyReportDismissed, mutedBody,
    type ModerationNoticeCallbacks,
} from './moderation-notices.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const AUTO_HIDE = { reporters: 3, reporterMinAgeDays: 7 } as const;
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

export function isHiddenByReports(postId: string): boolean {
    return !!postRow(postId)?.hidden_by_reports_at;
}

/**
 * The members whose open reports on this post count towards hiding it: distinct, not its author, active, a member
 * for at least 7 days when they reported it, and not someone a moderator already answered on this post.
 */
export function qualifyingReporters(postId: string): string[] {
    const post = postRow(postId);
    if (!post) return [];
    const rows = db.prepare(
        `SELECT ar.reporter_pubkey AS reporter, ar.created_at, m.joined_at
           FROM abuse_reports ar
           JOIN members m ON m.public_key = ar.reporter_pubkey
          WHERE ar.target_post_id = ? AND (ar.status = 'pending' OR ar.status IS NULL)
            AND ar.reporter_pubkey IS NOT ? AND m.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM abuse_reports d
                             WHERE d.target_post_id = ar.target_post_id AND d.reporter_pubkey = ar.reporter_pubkey
                               AND d.status = 'reviewed')`
    ).all(postId, post.author_pubkey) as { reporter: string; created_at: string | null; joined_at: string | null }[];
    const minAge = AUTO_HIDE.reporterMinAgeDays * DAY_MS;
    const out = new Set<string>();
    for (const r of rows) {
        const joined = r.joined_at ? Date.parse(r.joined_at) : NaN;
        const reported = r.created_at ? Date.parse(r.created_at) : NaN;
        // A time that can't be read proves nothing about the reporter's age, so it does not count.
        if (Number.isFinite(joined) && Number.isFinite(reported) && reported - joined >= minAge) out.add(r.reporter);
    }
    return [...out];
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
 * After a new report on a post: hide it when enough established members have reported it. True when this call
 * hid it. Does nothing where `autoHideReports` is off.
 */
export function evaluateAutoHide(cb: ModerationNoticeCallbacks, postId: string | null | undefined, now: number = Date.now()): boolean {
    if (!postId || !getProfileSwitches().autoHideReports) return false;
    const post = postRow(postId);
    if (!post || post.hidden_by_reports_at || post.active !== 1 || post.status === 'cancelled') return false;
    const reporters = qualifyingReporters(postId);
    if (reporters.length < AUTO_HIDE.reporters) return false;
    const at = iso(now);
    const res = db.prepare('UPDATE posts SET hidden_by_reports_at = ?, updated_at = ? WHERE id = ? AND hidden_by_reports_at IS NULL')
        .run(at, at, postId);
    if (res.changes === 0) return false;
    console.log(`🛡️ Post ${postId} hidden pending review: ${reporters.length} established members reported it.`);
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
    notifyPostBack(cb, forNotice(post));
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
    announceVisibilityChange(cb, postId);
    notifyPostBack(cb, forNotice(post));
    for (const r of reporters) if (r !== post.author_pubkey) notifyReportDismissed(cb, r, postId, post.active === 1 && post.status !== 'cancelled');
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
    if (qualifyingReporters(postId).length >= AUTO_HIDE.reporters) return false;
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
    const removals = (db.prepare(
        'SELECT COUNT(*) AS c FROM posts WHERE author_pubkey = ? AND removed_by_moderator_at > ?'
    ).get(authorPubkey, iso(since)) as { c: number }).c;
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
