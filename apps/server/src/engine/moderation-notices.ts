// What the people involved hear when the admins or moderators act on a post: its author, and the members who reported it.
//
// Two channels, both ones every app in the stores already handles:
//   - a push on the `marketplace` category, so the member's Marketplace notification preference applies;
//   - a live `system_announcement` event, which the phone app and the PWA already show as an alert. It goes
//     to the recipient's own sockets only (broadcast with recipients, no doorbell for anyone else).
// Neither names the admin or moderator who acted, and neither names anyone who reported: the author hears "the
// community's moderators", and each reporter hears only about their own report.

import { db } from '../db/db.js';

type BroadcastFn = (event: any, recipients?: string[], opts?: { othersGetDoorbell?: boolean }) => void;
type PushFn = (targetPubkeys: string[], actorPubkey: string, title: string, body: string, data: Record<string, any>, categoryId: 'chat' | 'marketplace' | 'escrow' | 'recovery') => void;

export interface ModerationNoticeCallbacks {
    broadcast: BroadcastFn;
    dispatchPushNotification: PushFn;
}

/** Why the admins removed a post, as the operator may choose it; the author reads the label. */
export const REMOVAL_REASON_LABELS: Record<string, string> = {
    spam: 'spam or a scam',
    offensive: 'offensive content',
    misleading: 'misleading',
    unsafe: 'unsafe or illegal',
    rules: "against this community's rules",
};

/** A known removal reason category, or null (anything else is ignored rather than shown to the author). */
export function normaliseRemovalReason(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const key = raw.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(REMOVAL_REASON_LABELS, key) ? key : null;
}

export const POST_REMOVED_TITLE = '🛡️ Your post was removed';
export const REPORT_OUTCOME_TITLE = '🛡️ Your report';

function quoted(title: string | null | undefined): string {
    const t = (title || '').trim();
    return t ? `"${t.length > 80 ? `${t.slice(0, 79)}…` : t}"` : 'your post';
}

export function postRemovedBody(title: string | null | undefined, reasonCategory?: string | null): string {
    const label = reasonCategory ? REMOVAL_REASON_LABELS[reasonCategory] : undefined;
    const what = title && title.trim() ? `Your post ${quoted(title)}` : 'Your post';
    return `${what} was removed by the community's moderators.${label ? ` Reason: ${label}.` : ''}`;
}

export function reportedPostRemovedBody(): string {
    return 'The post you reported was removed. Thank you for letting the moderators know.';
}

export function reportedPostKeptBody(): string {
    return 'The post you reported was reviewed and kept.';
}

/** The report was dismissed after its author had already taken the post down: "kept" would be untrue. */
export function reportedPostGoneBody(): string {
    return 'The post you reported is no longer up. Thank you for letting the moderators know.';
}

export const POSTS_CLEARED_TITLE = '🧹 Old listings cleared';

/** Prune Stale Posts: routine tidying, worded so it never reads like a takedown. */
export function postsClearedBody(count: number, olderThanDays?: number | null): string {
    const what = count === 1 ? 'one of your listings' : `${count} of your listings`;
    const age = olderThanDays && olderThanDays >= 1 ? ` older than ${olderThanDays} ${olderThanDays === 1 ? 'day' : 'days'}` : '';
    return `The community cleared ${what}${age}. This is routine tidying, not a report.`;
}

export function reportedPostsRemovedBody(count: number): string {
    return count > 1 ? `${count} posts you reported were removed. Thank you for letting the moderators know.` : reportedPostRemovedBody();
}

function tell(cb: ModerationNoticeCallbacks, recipients: string[], title: string, body: string, data: Record<string, any>): void {
    const to = Array.from(new Set(recipients.filter(pk => typeof pk === 'string' && pk && pk !== 'SYSTEM')));
    if (to.length === 0) return;
    try {
        cb.broadcast({ type: 'system_announcement', title, body, severity: 'info', ...data }, to);
    } catch (e: any) {
        console.warn('[Moderation] Live notice failed:', e?.message || e);
    }
    try {
        cb.dispatchPushNotification(to, 'SYSTEM', title, body, data, 'marketplace');
    } catch (e: any) {
        console.warn('[Moderation] Push failed:', e?.message || e);
    }
}

/**
 * Close every still-open report on a post the admins removed, and return who filed them. A removed post
 * leaves nothing to review, so those reports are actioned too; left open, they would keep the pending count
 * up for a post that is already gone.
 */
export function closeOpenReportsOnPost(postId: string): string[] {
    const rows = db.prepare(
        `SELECT DISTINCT reporter_pubkey FROM abuse_reports
          WHERE target_post_id = ? AND (status = 'pending' OR status IS NULL)`
    ).all(postId) as { reporter_pubkey: string }[];
    if (rows.length === 0) return [];
    db.prepare(
        `UPDATE abuse_reports SET status = 'actioned', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE target_post_id = ? AND (status = 'pending' OR status IS NULL)`
    ).run(postId);
    return rows.map(r => r.reporter_pubkey);
}

/**
 * The admins removed a post. The author is told (only when the post was live — removing an already-removed
 * post tells them nothing new), and so is each member whose report on it this closed.
 */
export function notifyPostTakedown(
    cb: ModerationNoticeCallbacks,
    post: { id: string; title: string | null; authorPubkey: string | null; wasLive: boolean },
    reporters: string[],
    reasonCategory?: string | null,
): void {
    // No `screen`: the post is gone, so a tap opens the app rather than a listing that no longer shows.
    const data = { kind: 'post_removed', postId: post.id };
    if (post.wasLive && post.authorPubkey) {
        tell(cb, [post.authorPubkey], POST_REMOVED_TITLE, postRemovedBody(post.title, reasonCategory ?? null), data);
    }
    const others = reporters.filter(pk => pk !== post.authorPubkey);
    // One call, one identical body: no recipient's notice names any other recipient.
    tell(cb, others, REPORT_OUTCOME_TITLE, reportedPostRemovedBody(), { kind: 'report_outcome', outcome: 'removed', postId: post.id });
}

/**
 * An admin dismissed a report on a post: its reporter hears the post was reviewed and kept — or, when its
 * author had already taken it down, only that it is no longer up.
 */
export function notifyReportDismissed(cb: ModerationNoticeCallbacks, reporterPubkey: string, postId: string, postIsLive = true): void {
    if (postIsLive) {
        tell(cb, [reporterPubkey], REPORT_OUTCOME_TITLE, reportedPostKeptBody(), { kind: 'report_outcome', outcome: 'kept', screen: 'post', postId });
    } else {
        tell(cb, [reporterPubkey], REPORT_OUTCOME_TITLE, reportedPostGoneBody(), { kind: 'report_outcome', outcome: 'gone', postId });
    }
}

/**
 * Prune Stale Posts removed a batch. Each author hears once, with the count, in words that say this was
 * tidying and not a takedown; each reporter whose reports it closed hears once, however many posts that was.
 * One notice per person, so nobody's app stacks an alert per post.
 */
export function notifyPostsCleared(
    cb: ModerationNoticeCallbacks,
    removed: { id: string; authorPubkey: string | null; wasLive: boolean; createdAt: string | null }[],
    reportersByPost: Map<string, string[]>,
    now = Date.now(),
): void {
    const byAuthor = new Map<string, { count: number; youngestMs: number | null }>();
    for (const p of removed) {
        if (!p.wasLive || !p.authorPubkey) continue;
        const a = byAuthor.get(p.authorPubkey) ?? { count: 0, youngestMs: null };
        a.count++;
        const t = p.createdAt ? new Date(p.createdAt).getTime() : NaN;
        if (Number.isFinite(t)) a.youngestMs = a.youngestMs === null ? t : Math.max(a.youngestMs, t);
        byAuthor.set(p.authorPubkey, a);
    }
    for (const [author, a] of byAuthor) {
        // "Older than N days" holds for every post in the batch: N is the youngest one's whole days.
        const days = a.youngestMs === null ? null : Math.floor((now - a.youngestMs) / 86_400_000);
        tell(cb, [author], POSTS_CLEARED_TITLE, postsClearedBody(a.count, days), { kind: 'posts_cleared', count: a.count });
    }
    const authorOf = new Map(removed.map(p => [p.id, p.authorPubkey]));
    const byReporter = new Map<string, number>();
    for (const [postId, reporters] of reportersByPost) {
        for (const r of new Set(reporters)) {
            if (r === authorOf.get(postId)) continue;
            byReporter.set(r, (byReporter.get(r) ?? 0) + 1);
        }
    }
    for (const [reporter, n] of byReporter) {
        tell(cb, [reporter], REPORT_OUTCOME_TITLE, reportedPostsRemovedBody(n), { kind: 'report_outcome', outcome: 'removed' });
    }
}
