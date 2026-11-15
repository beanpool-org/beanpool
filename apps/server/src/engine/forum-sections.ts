/**
 * A forum section tied to a group (slice F8; scratch/fable-design/DESIGN-forums-fable.md §4, §11; the joint design §2.3): the
 * one rule for who reads one and who writes in one. Every read of the forum takes it from here (engine/forum.ts, forum-search.ts,
 * forum-notices.ts, forum-moderation.ts, forum-first-look.ts, push-notices.ts), so none can miss it.
 *
 * - **Who reads:** the group's active members, any role (an observer reads, as a group's posts show to one), and this
 *   community's owners, admins and moderators (design §2: the server holds the words, and they read every section). Nobody
 *   else learns that it exists: no row in the forum's front, no topic in a list, no search hit, no bell row, no doorbell, no
 *   count; a topic, a photo, a reply, a follow, a report or a poll answers "not found", exactly as an id nobody has.
 * - **Who writes** (a topic, a reply, an edit, a poll): the group's active convenors and members, as its posts and its chat.
 *   Its observers, and owners, admins and moderators who are not in it, read and are refused (403 `group_only`).
 * - **Guests** from other communities (slice G1) are rows of group_guests, never of group_members, so none reads or writes here.
 * - A section with no group (`group_id` empty) is every member's, as before. A group that is gone leaves its section to the
 *   moderators alone: nobody holds a membership row of it.
 */
import { db } from '../db/db.js';

/**
 * SQL, true where `reader` moderates this forum: an owner, an admin or a moderator whose role acts. engine/node-roles.ts
 * NODE_ROLE_ACTS and engine/forum-moderation.ts isForumModerator, written with aliases of its own so a caller's `m` (a members
 * row it reads for) is never shadowed.
 */
const moderatesSql = (reader: string) => `EXISTS (SELECT 1 FROM node_roles fs_nr JOIN members fs_m ON fs_m.public_key = fs_nr.member_pubkey
    WHERE fs_nr.member_pubkey = ${reader} AND fs_nr.role IN ('owner', 'admin', 'moderator') AND fs_m.status = 'active' AND fs_m.is_visitor = 0)`;

/**
 * SQL, true where `reader` may read section `section`: it has no group, or the reader is an active member of its group, or a
 * moderator. Both are SQL expressions: a parameter (`@reader`) or a column (a members row's key, a topic's section_id). A
 * section that is not there stops nothing here (each read has its own rule for that).
 */
export function sectionReadSql(section: string, reader: string): string {
    return `NOT EXISTS (SELECT 1 FROM forum_sections fs_s WHERE fs_s.id = ${section} AND fs_s.group_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM group_members fs_gm WHERE fs_gm.group_id = fs_s.group_id AND fs_gm.member_pubkey = ${reader} AND fs_gm.status = 'active')
        AND NOT ${moderatesSql(reader)})`;
}

/** What a member may do in a section: nothing (it isn't there for them), read, or read and write. */
export type SectionAccess = 'none' | 'read' | 'write';

/** `member`'s access to a section with this group (null: every member's section, which the forum's own rules then hold). */
export function sectionAccess(member: string, groupId: string | null): SectionAccess {
    if (!groupId) return 'write';
    const role = db.prepare("SELECT role FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active'").pluck().get(groupId, member) as string | undefined;
    if (role === 'convenor' || role === 'member') return 'write';
    if (role === 'observer') return 'read';
    return db.prepare(`SELECT ${moderatesSql('?')} AS m`).pluck().get(member) ? 'read' : 'none';
}

/** The group a section is tied to, or null (none, or no such section). */
export function sectionGroupOf(sectionId: string): string | null {
    return (db.prepare('SELECT group_id FROM forum_sections WHERE id = ?').pluck().get(sectionId) as string | null | undefined) ?? null;
}

/** Everyone who reads a group's section: its active members and the moderators (a doorbell for that section's list). */
export function sectionReaders(groupId: string): string[] {
    return db.prepare(`SELECT member_pubkey FROM group_members WHERE group_id = @g AND status = 'active'
        UNION SELECT nr.member_pubkey FROM node_roles nr JOIN members m ON m.public_key = nr.member_pubkey
         WHERE nr.role IN ('owner', 'admin', 'moderator') AND m.status = 'active' AND m.is_visitor = 0`).pluck().all({ g: groupId }) as string[];
}

/**
 * Of these topic ids, those `reader` may not read for their section (a group's they are not in): their bell rows are not
 * there for them (engine/push-notices.ts). An id with no topic behind it is no section's, so it is not in the answer.
 */
export function forumTopicsOutOfReach(reader: string, topicIds: readonly string[]): Set<string> {
    const ids = [...new Set(topicIds.filter((id) => typeof id === 'string' && id.length > 0))];
    if (ids.length === 0) return new Set();
    return new Set(db.prepare(`SELECT t.id FROM forum_topics t WHERE t.id IN (SELECT value FROM json_each(@ids)) AND NOT ${sectionReadSql('t.section_id', '@reader')}`)
        .pluck().all({ ids: JSON.stringify(ids), reader }) as string[]);
}

// ── A topic's poll and the polls' pool (design §10.1) ───────────────────────────────────────────────────────────

/** The open polls topics hold in a section: their own pool, at most FORUM_LIMITS.pollsPerSection. */
export function forumSectionOpenPolls(sectionId: string): number {
    return db.prepare(`SELECT COUNT(*) FROM posts p JOIN forum_topics t ON t.poll_post_id = p.id
        WHERE t.section_id = ? AND p.type = 'poll' AND p.status = 'active'`).pluck().get(sectionId) as number;
}

/** The section whose topic holds poll `postId`, or null for a poll no topic holds (one of the community's). */
export function forumPollSection(postId: string): string | null {
    return (db.prepare('SELECT section_id FROM forum_topics WHERE poll_post_id = ?').pluck().get(postId) as string | undefined) ?? null;
}

/** SQL, true where posts row `post` is a poll a forum topic holds: counted in its section's pool, never in the community's. */
export const forumHeldPollSql = (post: string) => `${post} IN (SELECT poll_post_id FROM forum_topics WHERE poll_post_id IS NOT NULL)`;
