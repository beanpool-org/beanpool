/**
 * First looks (slice F2; scratch/fable-design/DESIGN-forums-fable.md §5, §9; Marty's answer to Q4, 14 Nov 2026): where
 * `forumFirstLook` is on (the global community), a new member's topic waits for one look by a moderator before it shows.
 * engine/forum.ts holds it (holdFirstTopic) and this file answers it.
 *
 * - **Not a topic.** It lives in forum_waiting until a moderator says yes, so it cannot leak into a list, a read, a search,
 *   a public page or a standby's topics by a missed filter (Learn's rule). One waits at a time a member.
 * - **Who looks.** The community's owners, admins and moderators (engine/forum-moderation.ts isForumModerator), in the
 *   apps ("Waiting for a first look (n)"), never in Settings. Never on their own (they are known, so theirs never waits),
 *   and never by an owner's assistant: these routes are member-signed only.
 * - **OK** makes the topic in the writer's name, its opening post written when they wrote it (so the one-hour edit rule
 *   holds for it), its activity now, its photos moved to it, and marks the writer known. **No** takes one of the five
 *   reasons a removal gives and deletes its photos. The writer hears by the bell either way, and never who answered.
 * - **The writer** sees their waiting topic with "Usually within {n} hours" (the middle of the last 20 answers) and can
 *   withdraw it. One not looked at in 30 days goes back to them, with words that say so.
 * - **Kept** 30 days after an answer, then deleted with its tombstone (a standby's copy follows).
 *
 * Every write refuses on a standby. Pushes say only that something waits or has an answer; the words are in the bell.
 */
import crypto from 'node:crypto';
import { FORUM_TIMES, word, wordsFor } from '@beanpool/core';
import { db, deletePlainRows } from '../db/db.js';
import { getNodeRole } from './sync.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { getMember } from '@beanpool/engine';
import { ForumRefusal, type ForumWaitingTopic } from './forum.js';
import { forumModerators, isForumModerator } from './forum-moderation.js';
import { normaliseRemovalReason, REMOVAL_REASON_LABELS, tell, type ModerationNoticeCallbacks } from './moderation-notices.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const { t: tr } = wordsFor('en');

/** How many of the latest answers the writer's "Usually within {n} hours" is measured from (design §5). */
export const FIRST_LOOK_MEASURED_FROM = 20;

export const FIRST_LOOK_WORDS = {
    notFound: word('This first topic isn’t waiting any more.'),
    moderatorsOnly: word('Only the community’s owners, admins and moderators look at first topics.'),
    reason: word('Choose one of the reasons a removal gives.'),
    sectionGone: word('The section this topic was written for isn’t here any more, so it can’t go up there.'),
    waitingTitle: word('A first topic is waiting for a look.'),
    waitingBody: word('A new member’s first topic is waiting for a moderator’s look in the forum.'),
    answeredTitle: word('Your first topic has an answer.'),
    expiredBody: word('No moderator looked at your first topic in 30 days, so it went back to you. You can start it again.'),
};

interface WaitingRow {
    id: string; section_id: string; writer_pubkey: string; title: string; words: string; place: string | null; lang: string | null;
    state: string; reason: string | null; topic_id: string | null; created_at: string; answered_at: string | null;
}

const waitingRow = (id: string) => db.prepare('SELECT * FROM forum_waiting WHERE id = ?').get(id) as WaitingRow | undefined;
const photosOf = (id: string) => (db.prepare('SELECT COUNT(*) FROM forum_waiting_photos WHERE waiting_id = ?').pluck().get(id) as number);

function out(r: WaitingRow): ForumWaitingTopic {
    return {
        id: r.id, sectionId: r.section_id, title: r.title, words: r.words, place: r.place, lang: r.lang, photos: photosOf(r.id),
        writer: { publicKey: r.writer_pubkey, name: getMember(db, r.writer_pubkey)?.callsign ?? '' }, createdAt: r.created_at,
    };
}

function moderatorOnly(reader: string): void {
    if (!isForumModerator(reader)) throw new ForumRefusal(403, 'moderators_only', FIRST_LOOK_WORDS.moderatorsOnly);
}

/**
 * The hours a first topic usually waits: the middle of the last 20 answers' waits (OK or No), rounded up, at least 1. Null
 * before any answer, when the apps say only that a moderator looks first.
 */
export function usuallyWithinHours(): number | null {
    const waits = (db.prepare(`SELECT created_at, answered_at FROM forum_waiting WHERE state IN ('ok', 'no') AND answered_at IS NOT NULL
                                ORDER BY answered_at DESC LIMIT ?`).all(FIRST_LOOK_MEASURED_FROM) as { created_at: string; answered_at: string }[])
        .map((r) => Date.parse(r.answered_at) - Date.parse(r.created_at)).filter((ms) => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
    if (waits.length === 0) return null;
    const mid = waits.length % 2 ? waits[(waits.length - 1) / 2] : (waits[waits.length / 2 - 1] + waits[waits.length / 2]) / 2;
    return Math.max(1, Math.ceil(mid / HOUR_MS));
}

/** For a moderator: every first topic waiting, oldest first. */
export function listFirstLooks(reader: string): { waiting: ForumWaitingTopic[] } {
    moderatorOnly(reader);
    const rows = db.prepare("SELECT * FROM forum_waiting WHERE state = 'waiting' ORDER BY created_at, id").all() as WaitingRow[];
    return { waiting: rows.map(out) };
}

/** For its writer: their first topic waiting, if any, and how long one usually waits. */
export function myFirstLook(member: string): { waiting: ForumWaitingTopic | null; usuallyWithinHours: number | null } {
    const row = db.prepare("SELECT * FROM forum_waiting WHERE writer_pubkey = ? AND state = 'waiting' ORDER BY created_at DESC LIMIT 1").get(member) as WaitingRow | undefined;
    return { waiting: row ? out(row) : null, usuallyWithinHours: usuallyWithinHours() };
}

/** One of a waiting topic's photos, for a moderator or its writer; null when there is none. */
export function firstLookPhoto(reader: string, id: string, n: number): string | null {
    const row = waitingRow(id);
    if (!row || row.state !== 'waiting' || (row.writer_pubkey !== reader && !isForumModerator(reader))) return null;
    return (db.prepare('SELECT photo_data FROM forum_waiting_photos WHERE waiting_id = ? AND order_num = ?').pluck().get(id, n) as string | undefined) ?? null;
}

/** A first topic is waiting: every moderator hears it, by the bell and a push, never its words (design §9). */
export function tellFirstLookWaiting(cb: ModerationNoticeCallbacks, waiting: ForumWaitingTopic): void {
    const to = forumModerators().filter((pk) => pk !== waiting.writer.publicKey);
    tell(cb, to, FIRST_LOOK_WORDS.waitingTitle, FIRST_LOOK_WORDS.waitingBody, { kind: 'forum_first_look_waiting', waitingId: waiting.id, screen: 'forum_first_looks' });
}

const quoted = (title: string) => (title.length > 80 ? `${title.slice(0, 79)}…` : title);

/** A waiting row still waiting, or a refusal. */
function stillWaiting(id: string): WaitingRow {
    const row = waitingRow(id);
    if (!row || row.state !== 'waiting') throw new ForumRefusal(404, 'not_found', FIRST_LOOK_WORDS.notFound);
    return row;
}

/**
 * A moderator says yes: the topic is made in the writer's name, in the section it was written for, and the writer is known
 * from now. Its opening post keeps the time it was written; its activity is now, so it shows as new. 409 `section_gone`
 * when that section was archived or deleted meanwhile (No it instead).
 */
export function okFirstLook(cb: ModerationNoticeCallbacks, moderator: string, id: string, now = Date.now()): { topicId: string } {
    assertPlainTablesWritable();
    moderatorOnly(moderator);
    const row = stillWaiting(id);
    const section = db.prepare('SELECT archived_at FROM forum_sections WHERE id = ?').get(row.section_id) as { archived_at: string | null } | undefined;
    if (!section || section.archived_at) throw new ForumRefusal(409, 'section_gone', FIRST_LOOK_WORDS.sectionGone);
    const topicId = `ft-${crypto.randomBytes(12).toString('hex')}`;
    const postId = `fp-${crypto.randomBytes(12).toString('hex')}`;
    const at = iso(now);
    db.transaction(() => {
        if (db.prepare("UPDATE forum_waiting SET state = 'ok', topic_id = ?, answered_at = ? WHERE id = ? AND state = 'waiting'").run(topicId, at, id).changes === 0) {
            throw new ForumRefusal(404, 'not_found', FIRST_LOOK_WORDS.notFound);
        }
        db.prepare(`INSERT INTO forum_topics (id, section_id, title, writer_pubkey, place, lang, reply_count, last_activity_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(topicId, row.section_id, row.title, row.writer_pubkey, row.place, row.lang, at, row.created_at);
        db.prepare('INSERT INTO forum_posts (id, topic_id, number, writer_pubkey, words, lang, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
            .run(postId, topicId, row.writer_pubkey, row.words, row.lang, row.created_at);
        db.prepare(`INSERT INTO forum_post_photos (post_id, order_num, photo_data, bytes)
                     SELECT ?, order_num, photo_data, bytes FROM forum_waiting_photos WHERE waiting_id = ?`).run(postId, id);
        deletePlainRows('forum_waiting_photos', 'waiting_id = ?', id);
        db.prepare(`INSERT INTO forum_members (member_pubkey, known_at) VALUES (?, ?)
                     ON CONFLICT(member_pubkey) DO UPDATE SET known_at = COALESCE(forum_members.known_at, excluded.known_at)`).run(row.writer_pubkey, at);
    })();
    tell(cb, [row.writer_pubkey], FIRST_LOOK_WORDS.answeredTitle,
        tr('Your first topic “{title}” is up in the forum. From now on your topics go up at once.', { title: quoted(row.title) }),
        { kind: 'forum_first_look_answered', outcome: 'ok', topicId, screen: 'forum_topic' });
    return { topicId };
}

/** A moderator says no, with one of the five reasons a removal gives; the writer hears it and never who said it. */
export function noFirstLook(cb: ModerationNoticeCallbacks, moderator: string, id: string, rawReason: unknown, now = Date.now()): void {
    assertPlainTablesWritable();
    moderatorOnly(moderator);
    const reason = normaliseRemovalReason(rawReason);
    if (!reason) throw new ForumRefusal(400, 'reason_required', FIRST_LOOK_WORDS.reason);
    const row = stillWaiting(id);
    db.transaction(() => {
        if (db.prepare("UPDATE forum_waiting SET state = 'no', reason = ?, answered_at = ? WHERE id = ? AND state = 'waiting'").run(reason, iso(now), id).changes === 0) {
            throw new ForumRefusal(404, 'not_found', FIRST_LOOK_WORDS.notFound);
        }
        deletePlainRows('forum_waiting_photos', 'waiting_id = ?', id);
    })();
    tell(cb, [row.writer_pubkey], FIRST_LOOK_WORDS.answeredTitle,
        tr('A moderator looked at your first topic “{title}” and it did not go up. Reason: {reason}.', { title: quoted(row.title), reason: REMOVAL_REASON_LABELS[reason] }),
        { kind: 'forum_first_look_answered', outcome: 'no', waitingId: id });
}

/** Its writer takes their waiting topic back: nobody is told, its photos are deleted. */
export function withdrawFirstLook(member: string, id: string, now = Date.now()): void {
    assertPlainTablesWritable();
    const row = waitingRow(id);
    if (!row || row.state !== 'waiting' || row.writer_pubkey !== member) throw new ForumRefusal(404, 'not_found', FIRST_LOOK_WORDS.notFound);
    db.transaction(() => {
        db.prepare("UPDATE forum_waiting SET state = 'withdrawn', answered_at = ? WHERE id = ?").run(iso(now), id);
        deletePlainRows('forum_waiting_photos', 'waiting_id = ?', id);
    })();
}

/**
 * The tidy-up, on the main server: a first topic nobody looked at in 30 days goes back to its writer (told), and an answered
 * one is deleted 30 days after its answer, with its tombstone. Returns how many of each.
 */
export function tidyFirstLooks(cb: ModerationNoticeCallbacks, now = Date.now()): { expired: number; deleted: number } {
    if (getNodeRole() !== 'primary') return { expired: 0, deleted: 0 };
    const cutoff = iso(now - FORUM_TIMES.firstLookDays * DAY_MS);
    const old = db.prepare("SELECT id, writer_pubkey FROM forum_waiting WHERE state = 'waiting' AND created_at < ?").all(cutoff) as { id: string; writer_pubkey: string }[];
    db.transaction(() => {
        for (const r of old) {
            db.prepare("UPDATE forum_waiting SET state = 'expired', answered_at = ? WHERE id = ? AND state = 'waiting'").run(iso(now), r.id);
            deletePlainRows('forum_waiting_photos', 'waiting_id = ?', r.id);
        }
    })();
    for (const r of old) tell(cb, [r.writer_pubkey], FIRST_LOOK_WORDS.answeredTitle, FIRST_LOOK_WORDS.expiredBody, { kind: 'forum_first_look_answered', outcome: 'expired', waitingId: r.id });
    const deleted = db.transaction(() => {
        deletePlainRows('forum_waiting_photos', "waiting_id IN (SELECT id FROM forum_waiting WHERE state != 'waiting' AND answered_at < ?)", cutoff);
        return deletePlainRows('forum_waiting', "state != 'waiting' AND answered_at < ?", cutoff);
    })();
    return { expired: old.length, deleted };
}

let tidyTimer: NodeJS.Timeout | null = null;
export function startTidyingFirstLooks(cb: ModerationNoticeCallbacks, everyMs = HOUR_MS): void {
    if (tidyTimer) return;
    tidyTimer = setInterval(() => {
        try { tidyFirstLooks(cb); } catch { /* the next hour tries again */ }
    }, everyMs);
    tidyTimer.unref?.();
}
