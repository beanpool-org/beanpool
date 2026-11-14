/**
 * Moderation of the forum (slice F2; scratch/fable-design/DESIGN-forums-fable.md §5 and §6, the joint design §2.4; Marty's
 * answer to Q4, 14 Nov 2026). "The same rules as posts, on one more target": a report names a forum post (an opening post or
 * a reply), and the auto-hide count, the restore, the moderator's removal with a reason its writer reads, the notices to the
 * writer and the reporters, and the auto-mute count all take a forum post where they take a listing.
 *
 * - **Moderators** here are the community's owners, admins and moderators (engine/node-roles.ts): reports and first looks.
 *   A moderator's role gives nothing else in the forum (Q4): pins, moves, sections stay with owners and admins.
 * - **Hidden** (`forum_posts.hidden_by_reports_at`): reporters in enough independent circles (engine/auto-moderation.ts
 *   forumHideTally, where `autoHideReports` is on), or a moderator's clean-up of a burst. Its writer and the moderators
 *   still read it, marked; anyone else reads a reply as "Hidden while moderators look" (no words, no photos) and nothing of
 *   a topic whose opening post is hidden. Hiding or showing an opening post touches its topic, so every list's tag moves.
 * - **Removed by a moderator**: the post's words and photos go at once, its row stays as a marker; an opening post takes its
 *   topic's title with it (gone from every list when nobody else replied). Its writer is told, with the reason; each
 *   reporter whose report it closed is told it went; the third removal in 30 days mutes the writer where `autoMute` is on.
 * - **New members** (forumNewness): on probation here (engine/probation.ts), with no node role and no topic a moderator
 *   OK'd. Their smaller day limits, no photos outside a waiting first topic, links shown as plain text, an hour to edit
 *   (engine/forum.ts), and their first topic waits for a look where `forumFirstLook` is on (engine/forum-first-look.ts).
 *
 * Nothing here names who reported or who acted: a writer hears "the community's moderators". No socket doorbell yet: the
 * forum's doorbells, to the people with a topic open or followed, are slice F5's; an app reads the topic again on open.
 */
import { word, wordsFor } from '@beanpool/core';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { nodeRoleOf } from './node-roles.js';
import { probationRuleSet, probationState } from './probation.js';
import { forumHideTally } from './auto-moderation.js';
import {
    REMOVAL_REASON_LABELS, REPORT_OUTCOME_TITLE, reportedPostGoneBody, reportedPostKeptBody, reportedPostRemovedBody, tell,
    type ModerationNoticeCallbacks,
} from './moderation-notices.js';

const { t: tr } = wordsFor('en');
const iso = (ms: number) => new Date(ms).toISOString();

/** Whether `pubkey` moderates this community's forum: an owner, an admin or a moderator (Marty, Q4). */
export function isForumModerator(pubkey: string | null | undefined): boolean {
    if (!pubkey) return false;
    const role = nodeRoleOf(pubkey);
    return role === 'owner' || role === 'admin' || role === 'moderator';
}

/** Every member who moderates the forum, for a first look's push. */
export function forumModerators(): string[] {
    return (db.prepare(`SELECT nr.member_pubkey FROM node_roles nr JOIN members m ON m.public_key = nr.member_pubkey
                         WHERE nr.role IN ('owner', 'admin', 'moderator') AND m.status = 'active'`).pluck().all() as string[]);
}

/** When a moderator first OK'd a topic of theirs, or null. */
export function forumKnownAt(member: string): string | null {
    return (db.prepare('SELECT known_at FROM forum_members WHERE member_pubkey = ?').get(member) as { known_at: string | null } | undefined)?.known_at ?? null;
}

export type ForumNewness = 'known' | 'new' | 'newWords';

/**
 * How new `member` is in this forum (design §5): `known` when they hold a node role, a moderator OK'd one topic of theirs,
 * or their new-account days are over (off probation, which a node with probation off never puts anyone on); otherwise
 * `newWords` when they came in with 12 words and added no sign-in, else `new`.
 */
export function forumNewness(member: string, now: number = Date.now()): ForumNewness {
    if (forumKnownAt(member) || !inNewAccountDays(member, now)) return 'known';
    return probationRuleSet(member) === 'words' ? 'newWords' : 'new';
}

/**
 * Whether `member` is in their new-account days here: on probation (engine/probation.ts: no node role, and a node with
 * probation on), whatever a first look said. The one-hour edit rule reads this, not forumNewness: OK makes a writer known,
 * and that rule exists so the very topic a moderator OK'd can't be swapped for something else (design §3).
 */
export function inNewAccountDays(member: string, now: number = Date.now()): boolean {
    return probationState(member, now).onProbation;
}

/** Whether each of these writers is known now, for drawing their links (a new writer's are plain text): one look each. */
export function knownWriters(writers: Iterable<string>, now: number = Date.now()): Map<string, boolean> {
    const out = new Map<string, boolean>();
    for (const w of writers) if (!out.has(w)) out.set(w, forumNewness(w, now) === 'known');
    return out;
}

// ── Reports ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface ModRow {
    id: string; topic_id: string; number: number; writer_pubkey: string; removed_by: string | null; removed_at: string | null;
    hidden_by_reports_at: string | null; title: string; closed_by: string | null;
}

function modRow(postId: string): ModRow | undefined {
    return db.prepare(`SELECT p.id, p.topic_id, p.number, p.writer_pubkey, p.removed_by, p.removed_at, p.hidden_by_reports_at, t.title, t.closed_by
                         FROM forum_posts p JOIN forum_topics t ON t.id = p.topic_id WHERE p.id = ?`).get(postId) as ModRow | undefined;
}

/**
 * The writer of a forum post `reporter` may report (POST /api/reports with `targetForumPostId`), or null when there is none
 * to report: the forum is off here, the post or its topic is gone or removed, or the reporter cannot read it. That is
 * engine/forum.ts's reading, rule for rule: a topic whose opening post is hidden is read by its writer and the moderators
 * only, and a hidden post's words by its own writer and the moderators only. So the writer of a hidden topic may report a
 * reply in it, and nobody else but a moderator may. A post by someone the reporter blocked may still be reported.
 */
export function reportableForumPostWriter(reporter: string, postId: unknown): string | null {
    if (typeof postId !== 'string' || !postId || !getProfileSwitches().forum) return null;
    const row = modRow(postId);
    if (!row || row.removed_by || row.closed_by === 'removed') return null;
    const topic = db.prepare(`SELECT t.writer_pubkey, (SELECT o.hidden_by_reports_at IS NOT NULL FROM forum_posts o WHERE o.topic_id = t.id AND o.number = 1) AS opening_hidden
                                FROM forum_topics t WHERE t.id = ?`).get(row.topic_id) as { writer_pubkey: string; opening_hidden: number | null } | undefined;
    if (!topic) return null;
    const moderator = isForumModerator(reporter);
    const topicHiddenToThem = !!topic.opening_hidden && reporter !== topic.writer_pubkey && !moderator;
    const postHiddenToThem = !!row.hidden_by_reports_at && reporter !== row.writer_pubkey && !moderator;
    return topicHiddenToThem || postHiddenToThem ? null : row.writer_pubkey;
}

/** The forum post a report names, for Settings' list (state-engine getReports): what a moderator judges it by. */
export interface ReportedForumPost {
    id: string; topicId: string; topicTitle: string; number: number; words: string; writerName: string | null;
    hidden: boolean; removed: boolean;
}

export function reportedForumPost(postId: string | null | undefined): ReportedForumPost | null {
    if (!postId) return null;
    const row = db.prepare(`SELECT p.id, p.topic_id, p.number, substr(p.words, 1, 500) AS words, p.removed_by, p.hidden_by_reports_at,
                                   t.title, t.closed_by, m.callsign
                              FROM forum_posts p JOIN forum_topics t ON t.id = p.topic_id LEFT JOIN members m ON m.public_key = p.writer_pubkey
                             WHERE p.id = ?`).get(postId) as
        { id: string; topic_id: string; number: number; words: string; removed_by: string | null; hidden_by_reports_at: string | null; title: string; closed_by: string | null; callsign: string | null } | undefined;
    if (!row) return null;
    return {
        id: row.id, topicId: row.topic_id, topicTitle: row.title, number: row.number, words: row.removed_by ? '' : row.words,
        writerName: row.callsign, hidden: !!row.hidden_by_reports_at, removed: !!row.removed_by || row.closed_by === 'removed',
    };
}

/** Every open report on a forum post closed as actioned, and who filed them (a removal leaves nothing to review). */
export function closeOpenReportsOnForumPost(postId: string): string[] {
    const reporters = db.prepare(`SELECT DISTINCT reporter_pubkey FROM abuse_reports
                                   WHERE target_forum_post_id = ? AND (status = 'pending' OR status IS NULL)`).pluck().all(postId) as string[];
    if (reporters.length === 0) return [];
    db.prepare(`UPDATE abuse_reports SET status = 'actioned', suspended_member = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE target_forum_post_id = ? AND (status = 'pending' OR status IS NULL)`).run(postId);
    return reporters;
}

// ── Notices ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const FORUM_MOD_WORDS = {
    hiddenTitle: word('🛡️ Your forum post is hidden for review'),
    backTitle: word('🛡️ Your forum post is back'),
    removedTitle: word('🛡️ Your forum post was removed'),
};

const quoted = (title: string) => {
    const t = title.trim();
    return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};

function hiddenBody(title: string): string {
    return title.trim()
        ? tr('Your post in the forum topic “{title}” is hidden while the community’s moderators look at reports about it. It has not been removed, and you can still see it.', { title: quoted(title) })
        : word('Your forum post is hidden while the community’s moderators look at reports about it. It has not been removed, and you can still see it.');
}

function backBody(title: string): string {
    return title.trim()
        ? tr('The community’s moderators looked at your post in the forum topic “{title}”, and everyone can see it again.', { title: quoted(title) })
        : word('The community’s moderators looked at your forum post, and everyone can see it again.');
}

/** The writer's notice of a moderator's removal: the reason one of the five people already read for a listing's. */
export function forumRemovedBody(title: string, reasonCategory: string | null): string {
    const label = reasonCategory ? REMOVAL_REASON_LABELS[reasonCategory] : undefined;
    if (title.trim()) {
        return label
            ? tr('Your post in the forum topic “{title}” was removed by the community’s moderators. Reason: {reason}.', { title: quoted(title), reason: label })
            : tr('Your post in the forum topic “{title}” was removed by the community’s moderators.', { title: quoted(title) });
    }
    return label
        ? tr('Your forum post was removed by the community’s moderators. Reason: {reason}.', { reason: label })
        : word('Your forum post was removed by the community’s moderators.');
}

const forumData = (row: { id: string; topic_id: string }, kind: string, extra: Record<string, unknown> = {}) =>
    ({ kind, forumPostId: row.id, topicId: row.topic_id, ...extra });

function tellReporterOutcome(cb: ModerationNoticeCallbacks, reporters: string[], row: ModRow, outcome: 'kept' | 'gone' | 'removed'): void {
    const others = reporters.filter((pk) => pk !== row.writer_pubkey);
    const body = outcome === 'kept' ? reportedPostKeptBody() : outcome === 'removed' ? reportedPostRemovedBody() : reportedPostGoneBody();
    tell(cb, others, REPORT_OUTCOME_TITLE, body, forumData(row, 'report_outcome', { outcome, ...(outcome === 'kept' ? { screen: 'forum_topic' } : {}) }));
}

// ── Hiding, showing, removing ─────────────────────────────────────────────────────────────────────────────────────

/** The topic's row touched, so every list's tag moves (engine/forum.ts forumListTag) when its opening post hides or shows. */
function touchTopic(topicId: string, at: string): void {
    db.prepare('UPDATE forum_topics SET updated_at = ? WHERE id = ?').run(at, topicId);
}


/**
 * After a new report on a forum post: hide it when reporters in enough independent circles count towards it (one for a
 * 12-words newcomer's post). True when this call hid it. Nothing where `autoHideReports` is off (every local community).
 */
export function evaluateForumAutoHide(cb: ModerationNoticeCallbacks, postId: string, now: number = Date.now()): boolean {
    if (!getProfileSwitches().autoHideReports) return false;
    const row = modRow(postId);
    if (!row || row.removed_by || row.hidden_by_reports_at) return false;
    const tally = forumHideTally(postId, now);
    if (tally.circles.length < tally.circlesNeeded) return false;
    const at = iso(now);
    const hid = db.transaction(() => {
        if (db.prepare('UPDATE forum_posts SET hidden_by_reports_at = ? WHERE id = ? AND hidden_by_reports_at IS NULL').run(at, postId).changes === 0) return false;
        touchTopic(row.topic_id, at);
        return true;
    })();
    if (!hid) return false;
    console.log(`🛡️ Forum post ${postId} hidden pending review: reporters in ${tally.circles.length} independent circles.`);
    tell(cb, [row.writer_pubkey], FORUM_MOD_WORDS.hiddenTitle, hiddenBody(row.title), forumData(row, 'forum_post_hidden', { reason: 'reports', screen: 'forum_topic' }));
    return true;
}

/** The hide lifted, its topic touched: true when it was hidden. Inside the caller's transaction; the notices are told after. */
function unhideRow(row: ModRow, at: string): boolean {
    if (db.prepare('UPDATE forum_posts SET hidden_by_reports_at = NULL WHERE id = ? AND hidden_by_reports_at IS NOT NULL').run(row.id).changes === 0) return false;
    touchTopic(row.topic_id, at);
    return true;
}

/** Shown again: everyone's open app reads it, and its writer hears it is back (unless it went since). */
function tellShown(cb: ModerationNoticeCallbacks, row: ModRow): void {
    if (!row.removed_by) tell(cb, [row.writer_pubkey], FORUM_MOD_WORDS.backTitle, backBody(row.title), forumData(row, 'forum_post_restored', { screen: 'forum_topic' }));
}

function unhide(cb: ModerationNoticeCallbacks, row: ModRow, now: number): boolean {
    if (!db.transaction(() => unhideRow(row, iso(now)))()) return false;
    tellShown(cb, row);
    return true;
}

/**
 * After a report on a forum post is dismissed: a hidden post whose remaining reports no longer add up is shown again. True
 * when this call showed it. Whatever the switch says: it only ever shows. A burst's hide is a moderator's, not reports': a
 * dismissal does not undo it (only its undo or a restore does).
 */
export function recheckHiddenForumPost(cb: ModerationNoticeCallbacks, postId: string, now: number = Date.now()): boolean {
    const row = modRow(postId);
    if (!row?.hidden_by_reports_at || hiddenByBurst(postId, row.hidden_by_reports_at)) return false;
    const tally = forumHideTally(postId, now);
    if (tally.circles.length >= tally.circlesNeeded) return false;
    return unhide(cb, row, now);
}

const hiddenByBurst = (postId: string, at: string) =>
    !!db.prepare(`SELECT 1 FROM burst_action_forum_posts bp JOIN burst_actions a ON a.id = bp.action_id
                   WHERE bp.post_id = ? AND a.at = ? AND a.undone_at IS NULL`).get(postId, at);

/**
 * A moderator restores a hidden forum post: shown to everyone again, and every open report on it dismissed, so each of those
 * reporters hears it was looked at and kept, and none of them can hide it again (only new reporters can).
 */
export function restoreHiddenForumPost(cb: ModerationNoticeCallbacks, postId: string, now: number = Date.now()): 'restored' | 'not_hidden' | 'not_found' {
    const row = modRow(postId);
    if (!row) return 'not_found';
    if (!row.hidden_by_reports_at) return 'not_hidden';
    let reporters: string[] = [];
    const restored = db.transaction(() => {
        if (!unhideRow(row, iso(now))) return false;
        reporters = db.prepare(`SELECT DISTINCT reporter_pubkey FROM abuse_reports WHERE target_forum_post_id = ? AND (status = 'pending' OR status IS NULL)`)
            .pluck().all(postId) as string[];
        db.prepare(`UPDATE abuse_reports SET status = 'reviewed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     WHERE target_forum_post_id = ? AND (status = 'pending' OR status IS NULL)`).run(postId);
        return true;
    })();
    if (!restored) return 'not_hidden';
    tellShown(cb, row);
    console.log(`🛡️ Forum post ${postId} restored by a moderator; ${reporters.length} open report(s) on it dismissed.`);
    tellReporterOutcome(cb, reporters, row, row.removed_by ? 'gone' : 'kept');
    return 'restored';
}

/** After a dismissal of one report on a forum post: its reporter hears it was kept, or only that it is no longer up. */
export function tellForumReportDismissed(cb: ModerationNoticeCallbacks, reporter: string, postId: string): void {
    const row = modRow(postId);
    if (!row) return;
    tellReporterOutcome(cb, [reporter], row, row.removed_by || row.closed_by === 'removed' ? 'gone' : 'kept');
}

/** The writer of a forum post, for a moderator's actions on it (whose post it is never comes from a report's own field). */
export function forumPostWriter(postId: string | null | undefined): string | null {
    if (!postId) return null;
    return (db.prepare('SELECT writer_pubkey FROM forum_posts WHERE id = ?').get(postId) as { writer_pubkey: string } | undefined)?.writer_pubkey ?? null;
}

export interface ForumRemoval { row: ModRow; wasUp: boolean }

/** What a moderator's removal tells, after its transaction commits: the writer (with the reason) and the reporters. */
export function tellForumRemoval(cb: ModerationNoticeCallbacks, removal: ForumRemoval, reporters: string[], reasonCategory: string | null): void {
    if (removal.wasUp) {
        tell(cb, [removal.row.writer_pubkey], FORUM_MOD_WORDS.removedTitle, forumRemovedBody(removal.row.title, reasonCategory), forumData(removal.row, 'forum_post_removed'));
    }
    tellReporterOutcome(cb, reporters, removal.row, 'removed');
}

/** The forum post a removal is about, read before it: its writer, its topic's title, whether it was still up. */
export function forumRemovalOf(postId: string): ForumRemoval | null {
    const row = modRow(postId);
    return row ? { row, wasUp: !row.removed_by && row.closed_by !== 'removed' } : null;
}
