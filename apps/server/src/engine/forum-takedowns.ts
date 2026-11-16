/**
 * An owner's or an admin's AI assistant takes a forum post down (slice F2b; scratch/fable-design/DESIGN-forums-fable.md §6, the
 * owner's assistant's row, and §21): a topic (its opening post) or a reply, on the owner's word, one post a call. What
 * engine/agent-takedowns.ts is for a listing, on one more target, with the same hold, the same 7 days and the same day's count.
 *
 * - **Take down** (`takeDownForumPost`), in one transaction: `hidden_by_reports_at` (kept if it was hidden, and noted here) and
 *   `taken_down_at`, so the forum's hidden state's whole reach applies (a topic whose opening post it is shows only to its writer
 *   and the moderators, a reply reads "Hidden while moderators look", no search, no public page), and the hold travels with the
 *   row. Every open report on it closes as actioned but a Child safety one, which waits for a person. Its writer reads a
 *   takedown's words, with the reason and never the assistant's own, and each reporter it closed hears it was removed. Refused,
 *   in words: no such post (a first look waiting is none: it is no post until a moderator OKs it), one removed, one already down,
 *   a role-holder's, and past the day's cap (the owners' "Owner and admin limit", one count with the listings').
 * - **On hold**, nothing brings it back but a person: a dismissed report doesn't (engine/forum-moderation.ts
 *   recheckHiddenForumPost), nor a burst's undo (engine/burst-cleanup.ts); a new report is never weighed (only a moderator can
 *   report a hidden post, and evaluateForumAutoHide skips a hidden one).
 * - **Put back** (`putBackForumTakedowns`, a person's: agent/takedowns-route.ts, through state-engine putBackTakedowns): back where
 *   it stood, the reports it closed open again and nobody told but its writer. A hide from before stays, unless a burst's undo
 *   skipped it during the hold or only the reports held it; where reports hide posts, a post that comes up is weighed against its
 *   reports, open again, and one they would hide now is hidden as of Put back. A moderator's restore is the same undo.
 * - **Final** after 7 days (`sweepForumTakedowns`, on the pulse scheduler's tick): a moderator's removal through state-engine's
 *   hook (engine/forum.ts removeForumPostAsModerator): words and photos gone, the row a marker. Never while a Child safety report
 *   is open: that waits for a person. Its writer heard at the takedown and hears nothing more. It counts towards the mute from
 *   then, not while on hold: a post on hold may yet be put back, so Put back never has a mute to lift.
 *
 * It moves no Bean: a forum post holds none. The record is this server's (a standby never copies it); records go after
 * TAKEDOWN.keepDays once nothing waits on them.
 */
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { getNodeRole } from '../config/node-role.js';
import { getReplacedInfo } from '../services/identity-epoch.js';
import { logger } from '../logger.js';
import { noteSecurityEvent, OWNER_ALERT_WORDS } from '../services/security-signal.js';
import { forumHideTally } from './auto-moderation.js';
import { holdsRole } from './burst-cleanup.js';
import { KEPT_WORDS, TAKEDOWN, takedownsTodayBy, type PutBackResult, type PutBackScope, type TakedownGrant } from './agent-takedowns.js';
import { tellForumPutBack } from './forum-moderation.js';
import {
    childSafetyOpenOn, closeReportsForTakedown, POST_TAKEN_DOWN_TITLE, postTakenDownBody, REMOVAL_REASON_LABELS, reopenClosedReports,
    REPORT_OUTCOME_TITLE, reportedPostRemovedBody, tell, type ModerationNoticeCallbacks,
} from './moderation-notices.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Why a forum post stays up, in words the assistant reads and passes on. */
export const FORUM_KEPT_WORDS = {
    forumOff: 'The forum is switched off here, so there is no forum post to take down.',
    notHere: 'There is no forum post or topic with that id here. A first topic waiting for a look is not a post yet: a moderator answers it in the app.',
    alreadyRemoved: KEPT_WORDS.alreadyRemoved,
    alreadyDown: KEPT_WORDS.alreadyDown,
    roleHolder: 'It is by an owner, an admin or a moderator: a person does that, in the app.',
    overLimit: KEPT_WORDS.overLimit,
} as const;

interface Row {
    id: string; topic_id: string; number: number; writer_pubkey: string; removed_by: string | null; hidden_by_reports_at: string | null;
    taken_down_at: string | null; title: string; closed_by: string | null;
}

const rowOf = (postId: string) => db.prepare(`SELECT p.id, p.topic_id, p.number, p.writer_pubkey, p.removed_by, p.hidden_by_reports_at, p.taken_down_at,
                                                     t.title, t.closed_by
                                                FROM forum_posts p JOIN forum_topics t ON t.id = p.topic_id WHERE p.id = ?`).get(postId) as Row | undefined;
const isGone = (p: Pick<Row, 'removed_by' | 'closed_by'>) => !!p.removed_by || p.closed_by === 'removed';
/** The topic touched, so every list's tag moves (engine/forum.ts forumListTag) when its opening post hides or shows. */
const touchTopic = (topicId: string, at: string) => db.prepare('UPDATE forum_topics SET updated_at = ? WHERE id = ?').run(at, topicId);

export interface ForumTakeDownInput {
    grant: TakedownGrant;
    /** A key of REMOVAL_REASON_LABELS, checked by the tool: what the writer reads. */
    reason: string;
    /** The assistant's own words, cleaned: Settings only. */
    why: string;
    via: 'ids' | 'reports';
    postId: string;
    /** The owners' "Owner and admin limit" now. */
    perDay: number;
}

export type ForumTakeDownResult =
    | { ok: true; takedownId: string; postId: string; topicId: string; kind: 'topic' | 'reply'; todayCount: number; perDay: number; finalAfter: string }
    | { ok: false; why: string };

/** Take one forum post down for one call (the file header). The notices and the alert go out after the commit. */
export function takeDownForumPost(cb: ModerationNoticeCallbacks, input: ForumTakeDownInput, now: number = Date.now()): ForumTakeDownResult {
    const { grant, reason, why, via, postId, perDay } = input;
    const at = iso(now);
    const id = crypto.randomUUID();
    let before = 0;
    let post: Row | undefined;
    let closed: { ids: string[]; reporters: string[] } = { ids: [], reporters: [] };
    const refusal = db.transaction((): string | null => {
        before = takedownsTodayBy(grant.id, now);
        post = rowOf(postId);
        if (!getProfileSwitches().forum) return FORUM_KEPT_WORDS.forumOff;
        if (!post) return FORUM_KEPT_WORDS.notHere;
        if (isGone(post)) return FORUM_KEPT_WORDS.alreadyRemoved;
        if (post.taken_down_at) return FORUM_KEPT_WORDS.alreadyDown;
        if (holdsRole(post.writer_pubkey)) return FORUM_KEPT_WORDS.roleHolder;
        if (before >= perDay) return FORUM_KEPT_WORDS.overLimit;
        db.prepare('UPDATE forum_posts SET hidden_by_reports_at = COALESCE(hidden_by_reports_at, ?), taken_down_at = ? WHERE id = ?').run(at, at, postId);
        if (post.number === 1) touchTopic(post.topic_id, at);
        closed = closeReportsForTakedown(postId, 'forum_post');
        db.prepare(`INSERT INTO agent_forum_takedowns (id, forum_post_id, grant_id, grant_name, member_pubkey, at, reason, why, via, hidden_before, reports_closed)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, postId, grant.id, grant.name, grant.member, at, reason, why, via, post.hidden_by_reports_at, JSON.stringify(closed.ids));
        return null;
    })();
    const p = post as Row | undefined;
    if (refusal || !p) return { ok: false, why: refusal ?? FORUM_KEPT_WORDS.notHere };
    const where = { forumPostId: p.id, topicId: p.topic_id };
    // A listing's takedown's words: an opening post is its topic, named by its title; a reply's writer opens its topic from the bell.
    tell(cb, [p.writer_pubkey], POST_TAKEN_DOWN_TITLE, postTakenDownBody(p.number === 1 ? p.title : null, reason),
        { kind: 'forum_post_hidden', reason: 'taken_down', screen: 'forum_topic', ...where });
    tell(cb, closed.reporters.filter((pk) => pk !== p.writer_pubkey), REPORT_OUTCOME_TITLE, reportedPostRemovedBody(), { kind: 'report_outcome', outcome: 'removed', ...where });
    logger.info('ADMIN', 'An AI assistant took a forum post down', {
        grant: grant.id, grantName: grant.name, member: grant.member.slice(0, 16), takedown: id, forumPost: p.id, reason, via,
    });
    // As a listing's (engine/agent-takedowns.ts): told at the first of the day for this assistant, then counted on one line.
    noteSecurityEvent({
        key: 'sec.agent', detail: '', perDay: OWNER_ALERT_WORDS.assistantTakedowns, perDayAdds: 1,
        actor: grant.member, actorRole: grant.role ?? 'owner', ...(before === 0 ? { high: true } : { quiet: true }),
    });
    return {
        ok: true, takedownId: id, postId: p.id, topicId: p.topic_id, kind: p.number === 1 ? 'topic' : 'reply',
        todayCount: before + 1, perDay, finalAfter: iso(now + TAKEDOWN.holdDays * DAY_MS),
    };
}

/** A burst's undo ran since this takedown and skipped the post: nothing is left to weigh that stamp but Put back. */
const burstUndoneSince = (postId: string, stamp: string, takenAt: string): boolean =>
    !!db.prepare(`SELECT 1 FROM burst_action_forum_posts bp JOIN burst_actions a ON a.id = bp.action_id
                   WHERE bp.post_id = ? AND a.at = ? AND a.undone_at >= ?`).get(postId, stamp, takenAt);

/** Only the reports can be holding this stamp: no burst stands behind it, and the post has a report (agent-takedowns' rule). */
const onlyReportsHold = (postId: string, stamp: string): boolean =>
    !db.prepare(`SELECT 1 FROM burst_action_forum_posts bp JOIN burst_actions a ON a.id = bp.action_id
                  WHERE bp.post_id = ? AND a.at = ? AND a.undone_at IS NULL`).get(postId, stamp)
    && !!db.prepare('SELECT 1 FROM abuse_reports WHERE target_forum_post_id = ? LIMIT 1').get(postId);

/** Put back, a person's (the file header): one post, one call (one post), or everything one assistant took down since a time. */
export function putBackForumTakedowns(cb: ModerationNoticeCallbacks, scope: PutBackScope, now: number = Date.now()): PutBackResult {
    const at = iso(now);
    const where = 'postId' in scope ? 'forum_post_id = ?' : 'takedownId' in scope ? 'id = ?' : 'grant_id = ? AND at >= ?';
    const args = 'postId' in scope ? [scope.postId] : 'takedownId' in scope ? [scope.takedownId] : [scope.grantId, scope.since];
    const reportsHide = getProfileSwitches().autoHideReports;
    const back: { row: Row; up: boolean }[] = [];
    let gone = 0;
    db.transaction(() => {
        const held = db.prepare(`SELECT id, forum_post_id, at, hidden_before, reports_closed FROM agent_forum_takedowns
                                  WHERE put_back_at IS NULL AND final_at IS NULL AND ${where}`).all(...args) as
            { id: string; forum_post_id: string; at: string; hidden_before: string | null; reports_closed: string }[];
        const toWeigh: { line: (typeof back)[number]; stamp: string }[] = [];
        for (const h of held) {
            const p = rowOf(h.forum_post_id);
            if (!p || isGone(p)) {
                db.prepare('UPDATE agent_forum_takedowns SET final_at = ? WHERE id = ?').run(at, h.id);
                gone++;
                continue;
            }
            const weigh = h.hidden_before
                ? burstUndoneSince(p.id, h.hidden_before, h.at) || (reportsHide && onlyReportsHold(p.id, h.hidden_before))
                : reportsHide;
            const stamp = weigh ? null : h.hidden_before;
            db.prepare('UPDATE forum_posts SET hidden_by_reports_at = ?, taken_down_at = NULL WHERE id = ?').run(stamp, p.id);
            db.prepare('UPDATE agent_forum_takedowns SET put_back_at = ? WHERE id = ?').run(at, h.id);
            reopenClosedReports(JSON.parse(h.reports_closed) as string[]);
            if (p.number === 1) touchTopic(p.topic_id, at);
            const line = { row: p, up: !stamp };
            back.push(line);
            if (weigh) toWeigh.push({ line, stamp: h.hidden_before ?? at });
        }
        // With every post here back and its reports open, each weighed against that same state, as a listing's Put back weighs.
        if (!reportsHide) return;
        for (const u of toWeigh) {
            const t = forumHideTally(u.line.row.id, now);
            if (t.circles.length < t.circlesNeeded) continue;
            db.prepare('UPDATE forum_posts SET hidden_by_reports_at = ? WHERE id = ?').run(u.stamp, u.line.row.id);
            u.line.up = false;
        }
    })();
    for (const b of back) tellForumPutBack(cb, b.row, b.up);
    return { back: back.map((b) => b.row.id), stillHidden: back.filter((b) => !b.up).map((b) => b.row.id), gone };
}

/** What makes a forum takedown final: a moderator's removal, with its notices (state-engine.ts). False: it refused, and it stays. */
type ForumTakedownRemoval = (postId: string) => boolean;
let removeForGood: ForumTakedownRemoval | null = null;
export function setForumTakedownRemoval(fn: ForumTakedownRemoval | null): void {
    removeForGood = fn;
}

/** The sweep (the file header). Safe on every tick: a standby, or a server replaced, makes nothing final. Returns how many. */
export function sweepForumTakedowns(now: number = Date.now()): number {
    if (!removeForGood || getNodeRole() === 'backup' || getReplacedInfo()) return 0;
    const at = iso(now);
    const due = db.prepare(`SELECT f.id, f.forum_post_id FROM agent_forum_takedowns f
                             WHERE f.put_back_at IS NULL AND f.final_at IS NULL AND f.at <= ? AND NOT ${childSafetyOpenOn('f.forum_post_id', 'forum_post')}
                             ORDER BY f.at LIMIT ?`).all(iso(now - TAKEDOWN.holdDays * DAY_MS), TAKEDOWN.sweepBatch) as { id: string; forum_post_id: string }[];
    const mark = (column: 'final_at' | 'put_back_at', id: string) => db.prepare(`UPDATE agent_forum_takedowns SET ${column} = ? WHERE id = ?`).run(at, id);
    let removed = 0;
    for (const d of due) {
        const p = rowOf(d.forum_post_id);
        // Removed meanwhile, by its writer or a person: nothing to do. Back up by a way that left this record behind: it stays up.
        if (!p || isGone(p)) { mark('final_at', d.id); continue; }
        if (!p.taken_down_at || !p.hidden_by_reports_at) { mark('put_back_at', d.id); continue; }
        try {
            if (removeForGood(p.id)) { mark('final_at', d.id); removed++; }
        } catch (e) {
            console.warn(`[Takedown] Forum post ${p.id} could not be made final this time:`, e);
        }
    }
    db.prepare('DELETE FROM agent_forum_takedowns WHERE (put_back_at IS NOT NULL OR final_at IS NOT NULL) AND at < ?').run(iso(now - TAKEDOWN.keepDays * DAY_MS));
    return removed;
}

export interface ForumTakedownLine {
    id: string; grantId: string; grantName: string; member: string | null; at: string; reason: string; reasonLabel: string; why: string; finalAfter: string;
    post: {
        id: string; topicId: string | null; topicTitle: string | null; kind: 'topic' | 'reply'; writer: string | null;
        /** hidden: waiting; left_hidden: past the 7 days, a Child safety report open, for a person; put_back; final. */
        state: 'hidden' | 'left_hidden' | 'put_back' | 'final';
        /** A Child safety report is open on it while it is held, on any day of the hold. */
        childSafetyOpen: boolean;
        putBackAt: string | null; finalAt: string | null;
    };
}

/** Settings' list, newest first: every takedown still waiting, and otherwise the newest `limit`; names and titles as they are now. */
export function listForumTakedowns(now: number = Date.now(), limit = 100): ForumTakedownLine[] {
    const rows = db.prepare(`SELECT f.*, m.callsign AS member_callsign, p.topic_id, p.number, t.title, w.callsign AS writer_callsign,
                                    ${childSafetyOpenOn('f.forum_post_id', 'forum_post')} AS child_safety
                               FROM agent_forum_takedowns f LEFT JOIN members m ON m.public_key = f.member_pubkey
                               LEFT JOIN forum_posts p ON p.id = f.forum_post_id LEFT JOIN forum_topics t ON t.id = p.topic_id
                               LEFT JOIN members w ON w.public_key = p.writer_pubkey
                              WHERE f.id IN (SELECT id FROM agent_forum_takedowns ORDER BY at DESC, rowid DESC LIMIT ?)
                                 OR (f.put_back_at IS NULL AND f.final_at IS NULL)
                              ORDER BY f.at DESC, f.rowid DESC`).all(limit) as {
        id: string; forum_post_id: string; grant_id: string; grant_name: string; member_callsign: string | null; at: string; reason: string; why: string;
        put_back_at: string | null; final_at: string | null; topic_id: string | null; number: number | null; title: string | null;
        writer_callsign: string | null; child_safety: number;
    }[];
    return rows.map((r) => {
        const finalAfter = iso(Date.parse(r.at) + TAKEDOWN.holdDays * DAY_MS);
        const held = !r.put_back_at && !r.final_at;
        const childSafetyOpen = held && !!r.child_safety;
        const state = r.put_back_at ? 'put_back' as const : r.final_at ? 'final' as const
            : childSafetyOpen && Date.parse(finalAfter) <= now ? 'left_hidden' as const : 'hidden' as const;
        return {
            id: r.id, grantId: r.grant_id, grantName: r.grant_name, member: r.member_callsign, at: r.at, reason: r.reason,
            reasonLabel: REMOVAL_REASON_LABELS[r.reason] ?? r.reason, why: r.why, finalAfter,
            post: {
                id: r.forum_post_id, topicId: r.topic_id, topicTitle: r.title || null, kind: r.number === 1 ? 'topic' as const : 'reply' as const,
                writer: r.writer_callsign, state, childSafetyOpen, putBackAt: r.put_back_at, finalAt: r.final_at,
            },
        };
    });
}
