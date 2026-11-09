// What the people involved hear when the admins or moderators act on a post: its author, and the members who reported it.
//
// Two channels, both ones every app in the stores already handles:
//   - a push on the `marketplace` category, so the member's Marketplace notification preference applies;
//   - a live `system_announcement` event, which the phone app and the PWA already show as an alert. It goes
//     to the recipient's own sockets only (broadcast with recipients, no doorbell for anyone else).
// And each recipient's copy is kept (engine/kept-notices.ts), because the web app has no push: it shows what its member
// has not seen the next time it opens (GET /api/notices).
// None of them names the admin or moderator who acted, or anyone who reported: the author hears "the community's
// moderators", and each reporter hears only about their own report.

import { word, wordsFor, type PushNoticeKind } from '@beanpool/core';
import { db } from '../db/db.js';
import { reportKind } from '../services/report-kind.js';
import { keepNotice, keptNoticeDetails, type KeptNoticePushOptions } from './kept-notices.js';

// English's own t(): a refusal with a value in it, which member-words.ts finds again by its catalog sentence.
const { t: tr } = wordsFor('en');

type BroadcastFn = (event: any, recipients?: string[], opts?: { othersGetDoorbell?: boolean }) => void;
type PushFn = (targetPubkeys: string[], actorPubkey: string, title: string, body: string, data: Record<string, any>, categoryId: 'chat' | 'marketplace' | 'escrow' | 'recovery', kind: PushNoticeKind,
    rehearsal?: boolean, options?: KeptNoticePushOptions) => void;

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

/**
 * One notice to each of these members: kept, live with its kept copy's id, and pushed. Also how every member hears that
 * how this community works changed (state-engine.ts noticeToEveryMember).
 */
export function tell(cb: ModerationNoticeCallbacks, recipients: string[], title: string, body: string, data: Record<string, any>): void {
    const to = Array.from(new Set(recipients.filter(pk => typeof pk === 'string' && pk && pk !== 'SYSTEM')));
    if (to.length === 0) return;
    // Each recipient's copy is kept first (engine/kept-notices.ts), so a web app that is closed now shows it when it
    // next opens; the live notice carries that copy's id, so the web app that shows it live marks it seen and never
    // shows it twice. One live notice per recipient: each names only their own copy.
    // Each push notice kept for the bell names its recipient's kept copy (`noticeId`), so acknowledging the alert takes the
    // row off the bell and a tap on the row marks the alert (state-engine.ts markBellNoticesSeen).
    const kept: { to: string; id: string | null }[] = [];
    for (const pk of to) {
        const noticeId = keepNotice(pk, title, body, data);
        kept.push({ to: pk, id: noticeId });
        try {
            cb.broadcast({ type: 'system_announcement', title, body, severity: 'info', ...data, ...(noticeId ? { noticeId } : {}) }, [pk]);
        } catch (e: any) {
            console.warn('[Moderation] Live notice failed:', e?.message || e);
        }
    }
    try {
        cb.dispatchPushNotification(to, 'SYSTEM', title, body, data, 'marketplace', 'community.notice', false, keptNoticeDetails(kept));
    } catch (e: any) {
        console.warn('[Moderation] Push failed:', e?.message || e);
    }
}

/**
 * Close every still-open report on a post the admins removed, and return who filed them. A Pulse report is about its
 * item, whatever post id it carries (state-engine reportSubjectOf), so it is never one of them. A removed post
 * leaves nothing to review, so those reports are actioned too; left open, they would keep the pending count
 * up for a post that is already gone.
 */
export function closeOpenReportsOnPost(postId: string): string[] {
    const rows = db.prepare(
        `SELECT DISTINCT reporter_pubkey FROM abuse_reports
          WHERE target_post_id = ? AND target_pulse_item_id IS NULL AND (status = 'pending' OR status IS NULL)`
    ).all(postId) as { reporter_pubkey: string }[];
    if (rows.length === 0) return [];
    db.prepare(
        `UPDATE abuse_reports SET status = 'actioned', suspended_member = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE target_post_id = ? AND target_pulse_item_id IS NULL AND (status = 'pending' OR status IS NULL)`
    ).run(postId);
    return rows.map(r => r.reporter_pubkey);
}

/**
 * What a takedown closes (engine/agent-takedowns.ts): every open report on the post but a Child safety one, which waits for a person,
 * first in the Open queue, and whose reporter hears nothing yet. Read as the alerts read it (`reportKind`). Returns the ids it closed,
 * so Put back can open them again, and who to tell: never a reporter whose Child safety report on this post is the one still waiting.
 */
export function closeReportsForTakedown(postId: string): { ids: string[]; reporters: string[] } {
    const open = db.prepare(
        `SELECT id, reporter_pubkey, reason FROM abuse_reports
          WHERE target_post_id = ? AND target_pulse_item_id IS NULL AND (status = 'pending' OR status IS NULL)`
    ).all(postId) as { id: string; reporter_pubkey: string; reason: string | null }[];
    const isWaiting = (r: { reason: string | null }) => reportKind(r.reason) === 'child safety';
    const closing = open.filter(r => !isWaiting(r));
    const close = db.prepare(
        `UPDATE abuse_reports SET status = 'actioned', suspended_member = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    );
    for (const r of closing) close.run(r.id);
    const stillWaiting = new Set(open.filter(isWaiting).map(r => r.reporter_pubkey));
    return { ids: closing.map(r => r.id), reporters: [...new Set(closing.map(r => r.reporter_pubkey))].filter(pk => !stillWaiting.has(pk)) };
}

/** The databases that have report_is_child_safety() (a test may open more than one in a process). */
const childSafetyFnOn = new WeakSet<object>();

/** report_is_child_safety(reason) on this connection, for a query (never the file schema): `reportKind`, read as the alerts read it. */
export function ensureChildSafetyFn(): void {
    if (childSafetyFnOn.has(db)) return;
    db.function('report_is_child_safety', { deterministic: true }, (reason: unknown) => (reportKind(reason) === 'child safety' ? 1 : 0));
    childSafetyFnOn.add(db);
}

/** SQL: a Child safety report is open on `post`, a column or a `?`. A Pulse report is about its item, so it is never one of them. */
export function childSafetyOpenOn(post: string): string {
    ensureChildSafetyFn();
    return `EXISTS (SELECT 1 FROM abuse_reports cs WHERE cs.target_post_id = ${post} AND cs.target_pulse_item_id IS NULL
        AND (cs.status = 'pending' OR cs.status IS NULL) AND report_is_child_safety(cs.reason) = 1)`;
}

/**
 * Reports a takedown closed, back in the moderators' queue as they were (engine/agent-takedowns.ts): an undo nobody read a post on is
 * no dismissal. Only a report still as `closeReportsForTakedown` left it: one a person dismissed since, or acted on to suspend its
 * member, stays as they left it. Nobody is told (the reporters' notice stands: scratch/fable-design/DESIGN-mcp-moderation-fable.md §3.5).
 */
export function reopenClosedReports(reportIds: string[]): number {
    const reopen = db.prepare(
        `UPDATE abuse_reports SET status = 'pending', suspended_member = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'actioned' AND suspended_member = 0`
    );
    return reportIds.reduce((n, id) => n + reopen.run(id).changes, 0);
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
 * author had already taken it down or a takedown has it on hold, only that it is no longer up.
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
    notifyReportersRemoved(cb, reportersByPost, new Map(removed.map(p => [p.id, p.authorPubkey])));
}

// ── Auto-moderation on the global profile (engine/auto-moderation.ts) ────────────────────────────

export const POST_HIDDEN_TITLE = '🛡️ Your post is hidden for review';
export const POST_BACK_TITLE = '🛡️ Your post is back';
export const MUTED_TITLE = '🛡️ Posting paused';
export const UNMUTED_TITLE = '🛡️ You can post again';
export const REQUESTS_CLEARED_TITLE = '🛡️ Your message requests were cleared';
export const REQUESTS_BACK_TITLE = '🛡️ You can send message requests again';

/** Hidden pending review, not removed: the author can still see it, and nobody else can until a moderator looks. */
export function postHiddenBody(title: string | null | undefined): string {
    const what = title && title.trim() ? `Your post ${quoted(title)}` : 'Your post';
    return `${what} is hidden while the community's moderators look at reports about it. It has not been removed, and you can still see it.`;
}

export function postBackBody(title: string | null | undefined): string {
    const what = title && title.trim() ? `your post ${quoted(title)}` : 'your post';
    return `The community's moderators looked at ${what}, and everyone can see it again.`;
}

/** The mute, in the words both its notice and every refusal it causes use. */
export function mutedBody(): string {
    return "Three of your posts were removed by the community's moderators in the last 30 days, so you can't post or send messages here until a moderator lifts this. You can still read, edit your profile and leave.";
}

/**
 * Reports cleared a sender's message requests (engine/request-limits.ts), in the words their notice and every refusal it
 * causes use. Never who reported them.
 */
export function requestsClearedBody(until: string): string {
    return tr("People you wrote to reported your message requests, so they were cleared and you can't send new ones until {date}. You can still answer people who wrote to you, and post.", { date: until.slice(0, 10) });
}

export function requestsBackBody(): string {
    return 'A moderator looked at the reports, so your message requests are back and you can send new ones.';
}

export function unmutedBody(): string {
    return 'A moderator lifted the pause, so you can post and send messages again.';
}

/**
 * Enough established members reported a post, so it is hidden until a moderator looks. Its author hears, as they
 * would of a removal, with the reason "reports". Never who reported it.
 */
export function notifyPostHidden(cb: ModerationNoticeCallbacks, post: { id: string; title: string | null; authorPubkey: string | null }): void {
    if (!post.authorPubkey) return;
    tell(cb, [post.authorPubkey], POST_HIDDEN_TITLE, postHiddenBody(post.title), { kind: 'post_hidden', reason: 'reports', screen: 'post', postId: post.id });
}

/** A hidden post is visible again: a moderator restored it, or the reports that hid it were dismissed. */
export function notifyPostBack(cb: ModerationNoticeCallbacks, post: { id: string; title: string | null; authorPubkey: string | null }): void {
    if (!post.authorPubkey) return;
    tell(cb, [post.authorPubkey], POST_BACK_TITLE, postBackBody(post.title), { kind: 'post_restored', screen: 'post', postId: post.id });
}

// ── An owner's AI assistant took posts down (engine/agent-takedowns.ts) ──────────────────────────

export const POST_TAKEN_DOWN_TITLE = word('🛡️ Your post was taken down');
export const POSTS_TAKEN_DOWN_TITLE = word('🛡️ Your posts were taken down');

/**
 * The closed list's label, never the assistant's own words, and never that an assistant did it: "the community's moderators", as
 * a moderator's removal never names the moderator. `count` above 1 is a batch's one notice.
 */
export function postTakenDownBody(title: string | null | undefined, reasonCategory: string, count = 1): string {
    const reason = REMOVAL_REASON_LABELS[reasonCategory] ?? REMOVAL_REASON_LABELS.rules;
    if (count > 1) return tr("{n} of your posts were taken down by the community's moderators. Reason: {reason}. They are hidden from everyone else; if they are not put back within 7 days they are removed.", { n: count, reason });
    return title && title.trim()
        ? tr("Your post {title} was taken down by the community's moderators. Reason: {reason}. It is hidden from everyone else; if it is not put back within 7 days it is removed.", { title: quoted(title), reason })
        : tr("Your post was taken down by the community's moderators. Reason: {reason}. It is hidden from everyone else; if it is not put back within 7 days it is removed.", { reason });
}

/** One notice to the author, however many of their posts the call took down. The post is theirs to open while it is hidden. */
export function notifyPostsTakenDown(cb: ModerationNoticeCallbacks, authorPubkey: string, posts: { id: string; title: string | null }[], reasonCategory: string): void {
    if (posts.length === 0) return;
    if (posts.length > 1) {
        tell(cb, [authorPubkey], POSTS_TAKEN_DOWN_TITLE, postTakenDownBody(null, reasonCategory, posts.length), { kind: 'post_hidden', reason: 'taken_down', count: posts.length });
        return;
    }
    const [post] = posts;
    tell(cb, [authorPubkey], POST_TAKEN_DOWN_TITLE, postTakenDownBody(post.title, reasonCategory), { kind: 'post_hidden', reason: 'taken_down', screen: 'post', postId: post.id });
}

/** Each reporter hears once, with the count, in the words a removal uses, never about a report of their own post. */
export function notifyReportersRemoved(cb: ModerationNoticeCallbacks, reportersByPost: Map<string, string[]>, authorOf: Map<string, string | null>): void {
    const byReporter = new Map<string, number>();
    for (const [postId, reporters] of reportersByPost) {
        for (const r of new Set(reporters)) {
            if (r === authorOf.get(postId)) continue;
            byReporter.set(r, (byReporter.get(r) ?? 0) + 1);
        }
    }
    for (const [reporter, n] of byReporter) tell(cb, [reporter], REPORT_OUTCOME_TITLE, reportedPostsRemovedBody(n), { kind: 'report_outcome', outcome: 'removed' });
}

// ── Clean-up by burst (engine/burst-cleanup.ts) ─────────────────────────────────────────────────

export const POSTS_HIDDEN_TITLE = '🛡️ Your posts are hidden for review';
export const POSTS_BACK_TITLE = '🛡️ Your posts are back';

/** A moderator hid a member's posts with others' in one action. Never why, nor who else, nor who acted. */
export function postsHiddenBody(count: number): string {
    return count === 1
        ? "One of your posts is hidden while the community's moderators look at it. It has not been removed, and you can still see it."
        : `${count} of your posts are hidden while the community's moderators look at them. They have not been removed, and you can still see them.`;
}

export function postsBackBody(count: number): string {
    return count === 1
        ? "The community's moderators looked at one of your posts, and everyone can see it again."
        : `The community's moderators looked at ${count} of your posts, and everyone can see them again.`;
}

/** One notice per author, however many of their posts the action hid, so nobody's app stacks an alert per post. */
export function notifyPostsHiddenForReview(cb: ModerationNoticeCallbacks, authorPubkey: string, count: number): void {
    if (count < 1) return;
    tell(cb, [authorPubkey], POSTS_HIDDEN_TITLE, postsHiddenBody(count), { kind: 'post_hidden', reason: 'moderators', count });
}

export function notifyPostsBack(cb: ModerationNoticeCallbacks, authorPubkey: string, count: number): void {
    if (count < 1) return;
    tell(cb, [authorPubkey], POSTS_BACK_TITLE, postsBackBody(count), { kind: 'post_restored', count });
}

export function notifyMuted(cb: ModerationNoticeCallbacks, memberPubkey: string): void {
    tell(cb, [memberPubkey], MUTED_TITLE, mutedBody(), { kind: 'moderation_muted' });
}

export function notifyRequestsCleared(cb: ModerationNoticeCallbacks, memberPubkey: string, until: string): void {
    tell(cb, [memberPubkey], REQUESTS_CLEARED_TITLE, requestsClearedBody(until), { kind: 'requests_cleared', until });
}

export function notifyRequestsBack(cb: ModerationNoticeCallbacks, memberPubkey: string): void {
    tell(cb, [memberPubkey], REQUESTS_BACK_TITLE, requestsBackBody(), { kind: 'requests_back' });
}

export function notifyUnmuted(cb: ModerationNoticeCallbacks, memberPubkey: string): void {
    tell(cb, [memberPubkey], UNMUTED_TITLE, unmutedBody(), { kind: 'moderation_unmuted' });
}
