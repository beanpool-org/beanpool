/**
 * A member starts at most one poll a week for the whole community (Marty, 4 Nov 2026, brainstorming spam on the Market: "limit
 * votes to 1 active owned voting card per person ... and also 1 a week - otherwise people could just keep placing them and
 * deleting them every day and their voting card is always at the top every day").
 *
 * The first half of that, one ACTIVE poll each, was already the rule (engine/posts.ts assertActivePollRoom). This is the
 * second: counted from when each poll was STARTED, so it holds whether the poll is still open, closed, completed, paused,
 * removed by its author or by a moderator, or archived since. Starting one a day and taking it down again does not get a
 * member round it.
 *
 * What it counts: polls shown to the whole community, the ones that take a place on the Market for everyone (Marty, 4 Nov,
 * ~22:40: the limit is about "real estate in the market place"). A poll aimed at one of the author's groups (audience_scope
 * 'group' with a target_group_id) or at one person ('direct') takes no one else's place on the Market, so it is not counted and
 * is not held: it keeps only the one-open-poll rule (assertActivePollRoom, which counts every audience). The audience is kept
 * in the poll's own row (engine/posts.ts createPost: audience_scope 'public' | 'group' | 'direct', NOT NULL with a CHECK in
 * schema.sql, and 'public' for every row from before audience scoping, db.ts). Not polls at all, and so untouched here: a removal or jury vote and every other
 * Decision (tables decisions, decision_votes, decision_jury_pools: decisions-engine.ts, engine/removal-jury.ts), a group's
 * convenor vote (group_convenor_proposals, group_convenor_votes: engine/group-succession.ts), a rekey proposal
 * (rekey_proposals: engine/rekey-redeem.ts) and an enterprise's succession vote (a scoped Decision). None of them is a row of
 * `posts`, and this reads only `posts` where type = 'poll'.
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
 *
 * Time: a node has no time zone of its own (docs/events-on-the-map.md §2.5: "any absolute time rendered on the server would be
 * wrong by that offset for every member. Relative words cannot be."), so the node's refusal says how long to wait, rounded UP
 * so it is never early, and never names a day. The apps say the day, in the member's own calendar (@beanpool/core poll-week).
 */

import { wordn, wordsFor, type AudienceScope } from '@beanpool/core';
import { db } from '../db/db.js';

const { tn } = wordsFor('en');

/** A week, as a clock counts it: 7 x 24 hours from the moment each poll was started. */
export const POLL_START_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
/** Up to this long the refusal counts hours; past it, days. */
const HOURS_UP_TO_MS = 48 * HOUR_MS;

const WAIT_HOURS = wordn(
    'You can start one community poll a week. Your next one can start in {n} hour.',
    'You can start one community poll a week. Your next one can start in {n} hours.',
);
const WAIT_DAYS = wordn(
    'You can start one community poll a week. Your next one can start in {n} day.',
    'You can start one community poll a week. Your next one can start in {n} days.',
);

/** The polls that count: shown to the whole community. A group's or one person's is not (see the top of this file). */
const COMMUNITY_POLL = "audience_scope = 'public'";

/**
 * When `authorPublicKey` may next start a poll for the whole community, as an ISO time, or null when they may now: the start
 * of their latest community poll inside the last week, plus the week. A poll for a group or for one person is not looked at.
 * Read for any author, owner or not; the callers decide who is held.
 */
export function nextPollStartAt(authorPublicKey: string, nowMs: number = Date.now()): string | null {
    const since = new Date(nowMs - POLL_START_WINDOW_MS).toISOString();
    const row = db.prepare(`SELECT MAX(created_at) AS last FROM posts WHERE author_pubkey = ? AND type = 'poll' AND origin_node IS NULL AND ${COMMUNITY_POLL} AND created_at > ?`)
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
 * Refuses a member's poll for the whole community started inside the week of their last such poll. Owners and admins pass,
 * and so does a poll for a group or for one person (`audienceScope` is what the new poll is aimed at). The refusal says how
 * long to wait, in hours up to two days and in days after, rounded up.
 */
export function assertPollStartRoom(authorPublicKey: string, ownersLimit: number | null, audienceScope: AudienceScope, nowMs: number = Date.now()): void {
    if (audienceScope !== 'public') return;
    const next = memberNextPollStartAt(authorPublicKey, ownersLimit, nowMs);
    if (!next) return;
    const left = Math.max(Date.parse(next) - nowMs, 1);
    if (left <= HOURS_UP_TO_MS) throw new Error(tn(Math.ceil(left / HOUR_MS), WAIT_HOURS.one, WAIT_HOURS.other));
    throw new Error(tn(Math.ceil(left / (24 * HOUR_MS)), WAIT_DAYS.one, WAIT_DAYS.other));
}
