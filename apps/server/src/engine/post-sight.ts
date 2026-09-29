// Who may know that a group or direct post exists (pre-launch small leaks, 2026-09-30).
//
// getPosts (@beanpool/engine posts.ts) shows a group post to its author and the group's active members only, and a direct
// post to its author, its target and its assignee only: to anyone else, in every feed, search, map read and read by id,
// it isn't there. The routes that take a post's id must agree. #983 made request and accept answer such a caller exactly
// as for an id nobody has; RSVP, a poll's vote and close, the event chat, the messaging routes on an event's chat and
// taking a post down each still answered with their own refusal ("Must be an active convenor or member of the group…",
// "Only the author can close a poll", "Only the host and people going…"), so anyone holding the id of an invite-only
// group's event or poll could learn that it was real, and that it was a group's.
//
// This is the one rule those routes read: the caller can't see the post, so it is answered as missing, before any other
// check on the post (its status, its end, who may act on it) can say otherwise. It never lets anyone do more: each route
// still refuses whoever it refused, only in the words it uses for an id nobody has.

import { db } from '../db/db.js';

/** The audience of a post: a posts row as SQLite returns it (snake_case), the columns getPosts' rule reads. */
export interface PostAudienceRow {
    author_pubkey: string;
    audience_scope?: string | null;
    target_group_id?: string | null;
    target_pubkey?: string | null;
    assigned_to?: string | null;
}

/**
 * Whether `caller` can't see this post in any feed (getPosts' audience rule): a group post, and the caller is neither its
 * author nor an active member of its group (any role: an observer sees it); or a direct post, and the caller is neither
 * its author, its target nor its assignee. A public post is everyone's; a caller with no key sees no other.
 */
export function postOutOfSight(row: PostAudienceRow, caller: string | undefined): boolean {
    const scope = row.audience_scope;
    if (!scope || scope === 'public') return false;
    if (!caller) return true;
    if (row.author_pubkey === caller) return false;
    if (scope === 'group') {
        return !row.target_group_id || !db.prepare(
            "SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active'"
        ).get(row.target_group_id, caller);
    }
    if (scope === 'direct') return row.target_pubkey !== caller && row.assigned_to !== caller;
    return false;
}

/**
 * postOutOfSight's rule as SQL, negated: true where the post is in sight of `caller`. `post` is the posts row's alias and
 * `caller` an SQL expression for the key (a column, such as an RSVP's member_pubkey). For the queries that hand out what
 * an RSVP gives (reminders, "Your events", the event's change pushes), so a member removed from the group, or who left it
 * or was banned, is left out of them as getPosts leaves the event out of their feed.
 */
export function postInSightSql(post: string, caller: string): string {
    return `(COALESCE(${post}.audience_scope, 'public') NOT IN ('group', 'direct')
        OR ${post}.author_pubkey = ${caller}
        OR (${post}.audience_scope = 'group' AND EXISTS (
            SELECT 1 FROM group_members sight_gm
             WHERE sight_gm.group_id = ${post}.target_group_id AND sight_gm.member_pubkey = ${caller} AND sight_gm.status = 'active'))
        OR (${post}.audience_scope = 'direct' AND (${post}.target_pubkey = ${caller} OR ${post}.assigned_to = ${caller})))`;
}

/** postOutOfSight, for a post as getPosts returns it (camelCase). */
export function marketplacePostOutOfSight(
    post: { authorPublicKey: string; audienceScope?: string | null; targetGroupId?: string | null; targetPubkey?: string | null; assignedTo?: string | null },
    caller: string | undefined,
): boolean {
    return postOutOfSight({
        author_pubkey: post.authorPublicKey,
        audience_scope: post.audienceScope,
        target_group_id: post.targetGroupId,
        target_pubkey: post.targetPubkey,
        assigned_to: post.assignedTo,
    }, caller);
}
