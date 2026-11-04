/**
 * A member starts at most one poll a week (Marty, 4 Nov 2026, brainstorming spam on the Market: "limit votes to 1 active
 * owned voting card per person ... and also 1 a week - otherwise people could just keep placing them and deleting them
 * every day and their voting card is always at the top every day").
 *
 * The first half of that, one ACTIVE poll each, was already the rule (engine/posts.ts assertActivePollRoom). This is the
 * second: counted from when each poll was STARTED, so it holds whether the poll is still open, closed, completed, paused,
 * removed by its author or by a moderator, or archived since. Starting one a day and taking it down again does not get a
 * member round it.
 *
 * Where the start is kept: in the poll's own row, and nowhere else. A poll is never hard-deleted. A removal is an UPDATE to
 * `status = 'cancelled'` (removePost, adminDeletePost), a close and a retention archive are UPDATEs too (closePoll,
 * archiveEndedPosts), deleting an account keeps the poll's question and votes (state-engine purge, test-delete-scrubs-posts),
 * and `created_at` is written once, at the INSERT, and never again. A standby gets the rows with the rest of the posts. So no
 * new table and no column: nothing for an older image booted on this data to trip over, and nothing to fall out of step with
 * the poll it counts. The count reads the (author_pubkey, created_at) partial index every author's listing read already uses.
 *
 * Who it holds: members. An owner or admin is held to the owners' "Owner and admin limit" in Settings, as the active-poll
 * limit holds them (engine/owner-admin-limit.ts), so the caller passes `ownersLimit` and an owner's is never refused here.
 * That includes an owner's AI assistant: it posts as the owner (agent/owner-posts.ts createPoll, which only an owner's
 * assistant may call) through createPost, so its poll is counted like any start and, should the owner ever be a member
 * again, it is in their week.
 *
 * Not a new start: resumePost putting back up a poll its author paused. It is the same poll, with its own start.
 */

import { wordsFor } from '@beanpool/core';
import { db } from '../db/db.js';

const { t: tr } = wordsFor('en');

/** A week, as a clock counts it: 7 x 24 hours from the moment each poll was started. */
export const POLL_START_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When `authorPublicKey` may next start a poll, as an ISO time, or null when they may now: the start of their latest poll
 * inside the last week, plus the week. Read for any author, owner or not; the callers decide who is held.
 */
export function nextPollStartAt(authorPublicKey: string, nowMs: number = Date.now()): string | null {
    const since = new Date(nowMs - POLL_START_WINDOW_MS).toISOString();
    const row = db.prepare("SELECT MAX(created_at) AS last FROM posts WHERE author_pubkey = ? AND type = 'poll' AND origin_node IS NULL AND created_at > ?")
        .get(authorPublicKey, since) as { last: string | null } | undefined;
    const last = row?.last ? Date.parse(row.last) : NaN;
    return Number.isFinite(last) ? new Date(last + POLL_START_WINDOW_MS).toISOString() : null;
}

/**
 * The same, for the member acting: null for an owner or admin (`ownersLimit` is ownerAdminLimit's answer, a number for
 * them), whose limit is the Settings one. What the apps ask before they open the poll form.
 */
export function memberNextPollStartAt(authorPublicKey: string, ownersLimit: number | null, nowMs: number = Date.now()): string | null {
    return ownersLimit !== null ? null : nextPollStartAt(authorPublicKey, nowMs);
}

/**
 * Refuses a member's poll started inside the week of their last. Owners and admins pass. The date in the refusal is the UTC
 * day (a node has no time zone of its own, docs/events-on-the-map.md §2.5), written the language's way on its way out
 * (member-words.ts valueIn); the apps say it before the form opens, in the member's own calendar (poll-week in both apps).
 */
export function assertPollStartRoom(authorPublicKey: string, ownersLimit: number | null, nowMs: number = Date.now()): void {
    const next = memberNextPollStartAt(authorPublicKey, ownersLimit, nowMs);
    if (next) throw new Error(tr('You can start one poll a week. Your next one can start on {date}.', { date: next.slice(0, 10) }));
}
