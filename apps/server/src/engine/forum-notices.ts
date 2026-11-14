/**
 * The forum's notices (slice F5; scratch/fable-design/DESIGN-forums-fable.md §9, §16; the joint design's step 3): follows,
 * the bell rows a topic's replies fold into, the four push kinds, the Forum switch, and the doorbells open apps hear.
 *
 * - **Follows** (forum_follows, copied to a standby). A member follows a topic they start, or reply in, unless they muted
 *   it; anyone who may read a topic follows it, stops following it or mutes it by its bell (engine/forum.ts followTopic). A
 *   muted topic tells them nothing: no reply, no mention, a reply of their own included.
 * - **A reply** tells each follower who may read it (an active member, not its writer, who blocked neither its writer nor
 *   the topic's, whose Forum switch is on, and, while the opening post is hidden, only the topic's writer and the
 *   moderators): one bell row and one push (`forum.reply`) for that topic. Each later reply folds into that row (its count,
 *   its newest post, back at the top of the bell) with no push, until the member opens the topic (markForumTopicRead) or
 *   takes the row off the bell. At most FORUM_PUSH_FOLLOWERS_MAX followers a reply, the most recently active (their last
 *   read or follow); the rest see the unread dot. The row is this server's own (push_notices), never copied: after a
 *   take-over a follower may be told once more.
 * - **A mention** (an @name of someone already in the topic, or a quote of their post) by a writer who is known (a new
 *   member's mentions tell nobody, design §5): one bell row per sender while it is unseen (later mentions fold into it), and
 *   at most one push an hour from the same sender (`forum.mention`): within the hour after one, a new row comes with no push.
 *   A member a reply mentions is told by the mention, not by that reply's fold as well.
 * - **The Forum switch** (`notify_forum`, Settings → Notifications) holds all four kinds, the first looks' too
 *   (engine/forum-first-look.ts): off, nothing of the forum reaches their bell, phone or browser.
 * - **Doorbells**, only to apps that say they read them (state-engine.ts tellForumSockets, `forum=1`): `forum_reply`
 *   { topicId, number } to the followers who may read it and to whoever read that topic in the last 15 minutes (held in
 *   memory, bounded), and `forum_list` to every member's socket at most once every 15 seconds. Visitors hear nothing.
 *
 * What a row says is generic or the member's own community's words: the topic's title, a count, and for a mention the
 * sender's name; never a reply's words. Every push sentence is core's (PUSH_NOTICE_KINDS). A standby writes nothing here.
 */
import { foldName } from '@beanpool/engine';
import {
    FORUM_PUSH_FOLLOWERS_MAX, FORUM_PUSH_PREF, PUSH_NOTICE_LIFETIME_SECONDS, forumMentions, wordsFor, type ForumFollow, type PushNoticeKind,
} from '@beanpool/core';
import { db, deletePlainRows } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { getNodeRole } from './sync.js';
import { forumNewness, isForumModerator } from './forum-moderation.js';

const { tn: trn } = wordsFor('en');
const iso = (ms: number) => new Date(ms).toISOString();
const seconds = (ms: number) => Math.floor(ms / 1000);

/** At most one mention push an hour from the same sender to the same member (design §9). */
export const FORUM_MENTION_PUSH_EVERY_SECONDS = 60 * 60;
/** Someone who read a topic this recently hears its replies' doorbell, following it or not. */
export const FORUM_READING_MS = 15 * 60 * 1000;
/** The forum list's doorbell goes at most this often (design §9). */
export const FORUM_LIST_NUDGE_MS = 15 * 1000;
/** The most topic readers held in memory for the doorbell, all topics together. */
const READERS_HELD_MAX = 5000;

/** What the forum's notices go out by (state-engine.ts forumNoticeCb). */
export interface ForumNoticeCallbacks {
    deliverPushNotices: (targets: string[], actor: string, title: string, body: string, data: Record<string, any>, category: 'forum', kind: PushNoticeKind,
        rehearsal?: boolean, options?: { bellOnly?: boolean }) => { sent: number; told: number };
    bellRowChanged: (pubkey: string, id: string, kind: PushNoticeKind) => void;
    bellSeenWhere: (pubkey: string, topicId: string) => string[];
    tellForum: (to: readonly string[] | null, event: { type: string } & Record<string, unknown>) => void;
}

// ── Follows ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The reader's follow of a topic and the last post number they opened (0: none). */
export function forumFollowOf(member: string, topicId: string): { follow: ForumFollow | null; lastRead: number } {
    const row = db.prepare('SELECT state, last_read FROM forum_follows WHERE topic_id = ? AND member_pubkey = ?').get(topicId, member) as
        { state: ForumFollow; last_read: number } | undefined;
    return { follow: row?.state ?? null, lastRead: row?.last_read ?? 0 };
}

/**
 * A member wrote in a topic (started it, replied, or a moderator OK'd their first topic): they follow it, unless they muted
 * it, and have read up to what they wrote (`readTo`). Inside the writer's transaction; the main server only.
 */
export function followForumTopic(member: string, topicId: string, now: number, readTo = 1): void {
    db.prepare(`INSERT INTO forum_follows (topic_id, member_pubkey, state, last_read, created_at) VALUES (?, ?, 'following', ?, ?)
        ON CONFLICT(topic_id, member_pubkey) DO UPDATE SET last_read = MAX(forum_follows.last_read, excluded.last_read)`)
        .run(topicId, member, readTo, iso(now));
}

/** Sets a member's follow of a topic they may read (engine/forum.ts followTopic checks that): following, muted, or neither. */
export function setForumFollow(member: string, topicId: string, follow: ForumFollow | null, now: number): ForumFollow | null {
    assertPlainTablesWritable();
    if (follow === null) {
        deletePlainRows('forum_follows', 'topic_id = ? AND member_pubkey = ?', topicId, member);
        return null;
    }
    db.prepare(`INSERT INTO forum_follows (topic_id, member_pubkey, state, last_read, created_at) VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(topic_id, member_pubkey) DO UPDATE SET state = excluded.state`).run(topicId, member, follow, iso(now));
    return follow;
}

/** A member's follows, every one: an account deleted or removed (engine/forum.ts dropForumOf), with their tombstones. */
export function dropForumFollowsOf(member: string): void {
    deletePlainRows('forum_follows', 'member_pubkey = ?', member);
}

/**
 * A member opened a topic, up to post number `upTo`: their unread dot moves (only forward), its bell rows (a reply's fold, a
 * mention, a first look's answer) come off the bell on every app they have open, and they hear its replies' doorbell for
 * the next FORUM_READING_MS. The topic is one they may read (engine/forum.ts). Returns how far they have now read.
 */
export function markForumTopicRead(cb: Pick<ForumNoticeCallbacks, 'bellSeenWhere'>, member: string, topicId: string, upTo: number, now = Date.now()): { lastRead: number } {
    noteForumReader(topicId, member, now);
    const last = (db.prepare('SELECT MAX(number) FROM forum_posts WHERE topic_id = ?').pluck().get(topicId) as number | null) ?? 0;
    const to = Math.max(0, Math.min(upTo, last));
    if (getNodeRole() === 'primary') {
        db.prepare('UPDATE forum_follows SET last_read = ? WHERE topic_id = ? AND member_pubkey = ? AND last_read < ?').run(to, topicId, member, to);
        cb.bellSeenWhere(member, topicId);
    }
    return { lastRead: forumFollowOf(member, topicId).lastRead };
}

// ── Who may be told ─────────────────────────────────────────────────────────────────────────────────────────────

interface TopicFacts { id: string; title: string; writer: string; openingHidden: boolean }

function topicFacts(topicId: string): TopicFacts | null {
    const row = db.prepare(`SELECT t.id, t.title, t.writer_pubkey,
            (SELECT p.hidden_by_reports_at IS NOT NULL FROM forum_posts p WHERE p.topic_id = t.id AND p.number = 1) AS opening_hidden
        FROM forum_topics t WHERE t.id = ? AND COALESCE(t.closed_by, '') != 'removed'`).get(topicId) as
        { id: string; title: string; writer_pubkey: string; opening_hidden: number | null } | undefined;
    return row ? { id: row.id, title: row.title, writer: row.writer_pubkey, openingHidden: !!row.opening_hidden } : null;
}

/**
 * Of these keys, those who may read what `writer` just wrote in the topic: active members (no visitor), not the writer, who
 * blocked neither the writer nor the topic's writer; while the opening post is hidden, only the topic's writer and the
 * moderators. `notices`: also not muted on this topic and with their Forum switch on (a doorbell needs neither).
 */
function mayBeTold(keys: readonly string[], topic: TopicFacts, writer: string, notices: boolean): string[] {
    if (keys.length === 0) return [];
    const rows = db.prepare(`SELECT m.public_key FROM members m
         WHERE m.public_key IN (SELECT value FROM json_each(@keys)) AND m.public_key != @writer
           AND m.status = 'active' AND COALESCE(m.is_visitor, 0) = 0
           AND m.public_key NOT IN (SELECT owner_pubkey FROM member_blocks WHERE blocked_pubkey IN (@writer, @topicWriter))
           AND (@notices = 0 OR (
                NOT EXISTS (SELECT 1 FROM forum_follows f WHERE f.topic_id = @topic AND f.member_pubkey = m.public_key AND f.state = 'muted')
            AND NOT EXISTS (SELECT 1 FROM member_preferences p WHERE p.public_key = m.public_key AND p.pref_key = @pref AND p.pref_value = 'false')))`)
        .pluck().all({ keys: JSON.stringify([...new Set(keys)]), writer, topicWriter: topic.writer, topic: topic.id, notices: notices ? 1 : 0, pref: FORUM_PUSH_PREF }) as string[];
    const allowed = new Set(rows);
    // In the order given (the followers' most recently active first).
    return [...new Set(keys)].filter((k) => allowed.has(k) && (!topic.openingHidden || k === topic.writer || isForumModerator(k)));
}

/** What fits a name for comparing: as a callsign is folded, and again with its spaces gone (an @name holds none). */
const nameForms = (name: string) => [foldName(name), foldName(name.replace(/\s+/g, ''))];

/**
 * Who a reply mentions: the writer of the post it quotes, and each @name that is someone already in the topic (its writer,
 * or anyone with a post still there). Never the reply's own writer.
 */
function mentionedIn(topic: TopicFacts, post: { writer: string; words: string; quotes: number | null }): string[] {
    const out = new Set<string>();
    if (post.quotes !== null) {
        const quoted = db.prepare('SELECT writer_pubkey FROM forum_posts WHERE topic_id = ? AND number = ? AND removed_by IS NULL').pluck().get(topic.id, post.quotes) as string | undefined;
        if (quoted) out.add(quoted);
    }
    const names = forumMentions(post.words);
    if (names.length > 0) {
        // Everyone in the topic and their names, in one read.
        const inTopic = db.prepare(`SELECT m.public_key AS pk, m.callsign FROM members m WHERE m.public_key = @writer
                OR m.public_key IN (SELECT writer_pubkey FROM forum_posts WHERE topic_id = @topic AND removed_by IS NULL)`)
            .all({ writer: topic.writer, topic: topic.id }) as { pk: string; callsign: string | null }[];
        const byName = new Map<string, string>();
        for (const { pk, callsign } of inTopic) {
            if (callsign) for (const f of nameForms(callsign)) if (!byName.has(f)) byName.set(f, pk);
        }
        for (const name of names) {
            const pk = byName.get(foldName(name));
            if (pk) out.add(pk);
        }
    }
    out.delete(post.writer);
    return [...out];
}

// ── A row that folds ────────────────────────────────────────────────────────────────────────────────────────────

interface BellRow { id: string; data: Record<string, unknown> }

/** The member's unseen row of this kind, within its lifetime, whose data says `field` = `value`; the newest. */
function unseenRow(recipient: string, kind: PushNoticeKind, field: 'topicId' | 'from', value: string, nowS: number): BellRow | null {
    const row = db.prepare(`SELECT id, data FROM push_notices WHERE recipient = ? AND kind = ? AND seen_at IS NULL AND sent_at >= ?
            AND json_valid(data) AND json_extract(data, '$.${field}') = ? ORDER BY sent_at DESC LIMIT 1`)
        .get(recipient, kind, nowS - PUSH_NOTICE_LIFETIME_SECONDS, value) as { id: string; data: string } | undefined;
    if (!row) return null;
    try {
        const data = JSON.parse(row.data);
        return { id: row.id, data: data && typeof data === 'object' && !Array.isArray(data) ? data : {} };
    } catch {
        return { id: row.id, data: {} };
    }
}

/** A row brought up to date with what just happened, back at the top of the bell; the member's open apps hear its id. */
function foldInto(cb: ForumNoticeCallbacks, recipient: string, kind: PushNoticeKind, row: BellRow, title: string, body: string, data: Record<string, unknown>, nowS: number): void {
    db.prepare('UPDATE push_notices SET title = ?, body = ?, data = ?, sent_at = ? WHERE id = ? AND recipient = ?')
        .run(title.slice(0, 200), body.slice(0, 1000), JSON.stringify({ ...row.data, ...data }), nowS, row.id, recipient);
    cb.bellRowChanged(recipient, row.id, kind);
}

const countOf = (data: Record<string, unknown>) => (Number.isSafeInteger(data.count) && (data.count as number) > 0 ? (data.count as number) : 1);
const titleOf = (title: string) => (title.length > 80 ? `${title.slice(0, 79)}…` : title);

const replyBody = (n: number) => trn(n, 'There is {n} new reply in a topic you follow.', 'There are {n} new replies in a topic you follow.');
const mentionBody = (n: number, name: string) => trn(n, '{name} mentioned you in the forum.', '{name} mentioned you {n} times in the forum.', { name });

// ── A reply ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ForumReplyFacts { id: string; topicId: string; number: number; writer: string; words: string; quotes: number | null }

/**
 * A reply was written (routes/forum.ts, after engine/forum.ts replyInForum): its followers and the people it mentions are
 * told, and open apps hear the doorbells. Never throws: a notice that fails to go leaves the reply as it is.
 */
export function tellForumReply(cb: ForumNoticeCallbacks, post: ForumReplyFacts, now = Date.now()): { pushed: string[]; folded: string[]; mentioned: string[] } {
    const out = { pushed: [] as string[], folded: [] as string[], mentioned: [] as string[] };
    if (getNodeRole() !== 'primary') return out;
    try {
        const topic = topicFacts(post.topicId);
        if (!topic) return out;
        const nowS = seconds(now);
        const title = titleOf(topic.title);
        const where = { screen: 'forum_topic', topicId: topic.id, postId: post.id, number: post.number };

        // Mentions first: a member mentioned in this reply is told by that alone.
        const mentioned = forumNewness(post.writer, now) === 'known' ? mayBeTold(mentionedIn(topic, post), topic, post.writer, true) : [];
        const name = (db.prepare('SELECT callsign FROM members WHERE public_key = ?').pluck().get(post.writer) as string | undefined) ?? '';
        const mentionPush: string[] = [];
        const mentionBell: string[] = [];
        for (const pk of mentioned) {
            const row = unseenRow(pk, 'forum.mention', 'from', post.writer, nowS);
            if (row) {
                const n = countOf(row.data) + 1;
                foldInto(cb, pk, 'forum.mention', row, title, mentionBody(n, name), { ...where, count: n }, nowS);
                continue;
            }
            const pushedLately = !!db.prepare(`SELECT 1 FROM push_notices WHERE recipient = ? AND kind = 'forum.mention' AND json_valid(data)
                    AND json_extract(data, '$.from') = ? AND json_extract(data, '$.pushedAt') > ?`).get(pk, post.writer, nowS - FORUM_MENTION_PUSH_EVERY_SECONDS);
            (pushedLately ? mentionBell : mentionPush).push(pk);
        }
        if (mentionPush.length > 0) cb.deliverPushNotices(mentionPush, post.writer, title, mentionBody(1, name), { ...where, from: post.writer, pushedAt: nowS, count: 1 }, 'forum', 'forum.mention');
        if (mentionBell.length > 0) cb.deliverPushNotices(mentionBell, post.writer, title, mentionBody(1, name), { ...where, from: post.writer, count: 1 }, 'forum', 'forum.mention', false, { bellOnly: true });
        out.mentioned = mentioned;

        // The followers, the most recently active first, at most FORUM_PUSH_FOLLOWERS_MAX.
        const following = db.prepare(`SELECT member_pubkey FROM forum_follows WHERE topic_id = ? AND state = 'following'
            ORDER BY COALESCE(updated_at, created_at) DESC, member_pubkey`).pluck().all(topic.id) as string[];
        const told = new Set(mentioned);
        const followers = mayBeTold(following.filter((pk) => !told.has(pk)), topic, post.writer, true).slice(0, FORUM_PUSH_FOLLOWERS_MAX);
        for (const pk of followers) {
            const row = unseenRow(pk, 'forum.reply', 'topicId', topic.id, nowS);
            if (!row) { out.pushed.push(pk); continue; }
            const n = countOf(row.data) + 1;
            foldInto(cb, pk, 'forum.reply', row, title, replyBody(n), { ...where, count: n }, nowS);
            out.folded.push(pk);
        }
        if (out.pushed.length > 0) cb.deliverPushNotices(out.pushed, post.writer, title, replyBody(1), { ...where, count: 1 }, 'forum', 'forum.reply');

        // The doorbells: followers and anyone reading it now get this reply; every member's list a nudge.
        cb.tellForum(mayBeTold([...following, ...readersOf(topic.id, now)], topic, post.writer, false), { type: 'forum_reply', topicId: topic.id, number: post.number });
        nudgeForumList(cb, now);
    } catch (e: any) {
        console.warn('[Forum] A reply\'s notices could not all go:', e?.message || e);
    }
    return out;
}

/** A topic went up (a member's own, or a first look a moderator OK'd): every member's open list hears it, within 15 seconds. */
export function tellForumTopic(cb: Pick<ForumNoticeCallbacks, 'tellForum'>, now = Date.now()): void {
    if (getNodeRole() === 'primary') nudgeForumList(cb, now);
}

// ── Doorbells ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Who read each topic lately, for its replies' doorbell: topic → reader → when (ms). The least recently read topic first. */
const readers = new Map<string, Map<string, number>>();
let readersHeld = 0;

/** A member read a topic now: they hear its replies' doorbell for FORUM_READING_MS. Bounded; nothing is kept on disk. */
export function noteForumReader(topicId: string, member: string, now = Date.now()): void {
    let byReader = readers.get(topicId);
    if (byReader) readers.delete(topicId);
    else byReader = new Map();
    if (!byReader.has(member)) readersHeld++;
    byReader.set(member, now);
    readers.set(topicId, byReader);
    while (readersHeld > READERS_HELD_MAX) {
        const oldest = readers.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        readersHeld -= readers.get(oldest)!.size;
        readers.delete(oldest);
    }
}

function readersOf(topicId: string, now: number): string[] {
    const byReader = readers.get(topicId);
    if (!byReader) return [];
    for (const [pk, at] of byReader) if (now - at > FORUM_READING_MS) { byReader.delete(pk); readersHeld--; }
    if (byReader.size === 0) readers.delete(topicId);
    return [...byReader.keys()];
}

let lastNudgeAt = 0;
let nudgeTimer: NodeJS.Timeout | null = null;

/** Every member's open forum list hears `forum_list` now, or, within 15 seconds of the last, once when they are up. */
function nudgeForumList(cb: Pick<ForumNoticeCallbacks, 'tellForum'>, now: number): void {
    if (nudgeTimer) return;
    const wait = lastNudgeAt + FORUM_LIST_NUDGE_MS - now;
    if (wait <= 0) {
        lastNudgeAt = now;
        cb.tellForum(null, { type: 'forum_list' });
        return;
    }
    nudgeTimer = setTimeout(() => {
        nudgeTimer = null;
        lastNudgeAt = Date.now();
        cb.tellForum(null, { type: 'forum_list' });
    }, wait);
    nudgeTimer.unref?.();
}

/** For tests: forget who read what, and when the list was last nudged. */
export function resetForumDoorbellsForTests(): void {
    readers.clear();
    readersHeld = 0;
    lastNudgeAt = 0;
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = null;
}
