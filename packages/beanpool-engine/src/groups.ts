// Groups, convenor moderation, and group membership engine.
// Docs: docs/the-commons.md §9 (Item 10)
//
// A group is an audience scope and NOTHING else:
// - It holds no money, grants no trust, confers no node role, and is never linked to an enterprise.
// - Separate role table: group_members (convenor | member | observer), plus ONE lead convenor per group
//   (groups.lead_pubkey, 2026-09-23).
// - Join policies: open | request_to_join | invite_only.
//
// THE LEAD CONVENOR (Marty's decision, 2026-09-23; mirrors the enterprise lead keeper, docs/the-commons.md §2.3):
//  - Any convenor can approve, invite and remove members and observers, promote someone to convenor, remove
//    posts and messages, and edit the group and its join policy.
//  - Only the lead can remove or demote a convenor.
//  - NOBODY can remove or demote the lead — not another convenor, and not a node admin (admins hold no power
//    over groups today, and this change gives them none).
//  - The lead changes by hand-over, by stepping down or leaving (hand over first while anyone else is active),
//    or by the 30-day-silence vote (apps/server/src/engine/group-succession.ts). No community Decision names a
//    group's lead as its subject, so that is not a route today.
// Every route goes through this file, so there is one place the rules live.

import type Database from 'better-sqlite3';
import {
    type Group,
    type GroupMember,
    type GroupRole,
    type JoinPolicy,
    type GroupCategory,
    type GroupMemberStatus,
    isGroupRole,
    isJoinPolicy,
    isGroupCategory,
    isGroupMemberStatus,
    DEFAULT_GROUP_CATEGORY
} from '@beanpool/core';

export type {
    Group,
    GroupMember,
    GroupRole,
    JoinPolicy,
    GroupCategory,
    GroupMemberStatus
};

type Db = Database.Database;

export interface CreateGroupParams {
    id?: string;
    name: string;
    slug?: string;
    description?: string;
    avatarUrl?: string;
    category?: GroupCategory;
    joinPolicy?: JoinPolicy;
    createdBy: string;
}

export interface UpdateGroupParams {
    name?: string;
    description?: string;
    avatarUrl?: string;
    category?: GroupCategory;
    joinPolicy?: JoinPolicy;
}

export interface ListGroupsFilter {
    category?: string;
    query?: string;
    memberPubkey?: string;
    limit?: number;
    offset?: number;
}

export function slugifyGroupName(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'group';
}

const SLUG_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * A new group's slug: the name's slug plus a random suffix, on every group. A counter only on a clash
 * ("quiet-circle-2") told whoever made a group that a group they cannot see already had that name: an invite-only
 * group's existence confirmed by guessing its name. With a suffix on every slug, a taken name and a fresh one come
 * back looking alike, and a clash on the whole slug just draws again. Slugs made before this keep their form.
 */
export function ensureUniqueSlug(db: Db, baseSlug: string): string {
    const base = baseSlug.slice(0, 43);
    while (true) {
        const bytes = crypto.getRandomValues(new Uint8Array(6));
        const suffix = Array.from(bytes, b => SLUG_SUFFIX_ALPHABET[b & 31]).join('');
        const slug = `${base}-${suffix}`;
        if (!db.prepare("SELECT 1 FROM groups WHERE slug = ?").get(slug)) return slug;
    }
}

export function createGroup(db: Db, params: CreateGroupParams): Group {
    const trimmedName = params.name?.trim();
    if (!trimmedName || trimmedName.length < 1 || trimmedName.length > 100) {
        throw new Error('Group name must be between 1 and 100 characters');
    }

    const category: GroupCategory = params.category ?? DEFAULT_GROUP_CATEGORY;
    if (!isGroupCategory(category)) {
        throw new Error(`Invalid group category: ${category}`);
    }

    const joinPolicy: JoinPolicy = params.joinPolicy ?? 'open';
    if (!isJoinPolicy(joinPolicy)) {
        throw new Error(`Invalid join policy: ${joinPolicy}`);
    }

    const member = db.prepare("SELECT public_key, status FROM members WHERE public_key = ?").get(params.createdBy) as any;
    if (!member || member.status === 'pruned') {
        throw new Error('Creator member not found or pruned');
    }

    const rawSlug = params.slug ? slugifyGroupName(params.slug) : slugifyGroupName(trimmedName);
    const slug = ensureUniqueSlug(db, rawSlug);
    const id = params.id || crypto.randomUUID();
    const now = new Date().toISOString();

    db.transaction(() => {
        db.prepare(`
            INSERT INTO groups (id, name, slug, description, avatar_url, category, created_by, lead_pubkey, join_policy, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            trimmedName,
            slug,
            params.description?.trim() || null,
            params.avatarUrl || null,
            category,
            params.createdBy,
            // The creator is the first lead convenor. Nothing else is special about them — exactly the enterprise
            // rule ("the creator is the first lead keeper", docs/the-commons.md §2.3).
            params.createdBy,
            joinPolicy,
            now,
            now
        );

        // Creator is the initial convenor with active status
        db.prepare(`
            INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at)
            VALUES (?, ?, 'convenor', 'active', ?, ?)
        `).run(id, params.createdBy, now, now);
    })();

    const created = getGroup(db, id, params.createdBy);
    if (!created) {
        throw new Error('Failed to create group');
    }
    return created;
}

export function getGroup(db: Db, idOrSlug: string, viewerPubkey?: string): Group | null {
    // convenor_pubkey is the LEAD convenor: "the group's convenor", wherever one name is shown, is the person who
    // leads it. Group info in both apps reads these fields, so naming the lead there needs no second query.
    const row = db.prepare(`
        SELECT g.*,
               (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.status = 'active') as member_count,
               ${leadPubkeySql('g')} as convenor_pubkey,
               m.callsign as convenor_callsign,
               m.avatar_url as convenor_avatar_url
        FROM groups g
        LEFT JOIN members m ON m.public_key = ${leadPubkeySql('g')}
        WHERE g.id = ? OR g.slug = ?
    `).get(idOrSlug, idOrSlug) as any;

    if (!row) return null;

    let viewerRole: GroupRole | undefined;
    let viewerStatus: GroupMemberStatus | undefined;
    let viewerInvitedBy: { pubkey: string; callsign?: string; avatarUrl?: string } | undefined;
    if (viewerPubkey) {
        const membership = db.prepare(`
            SELECT gm.role, gm.status, gm.invited_by, inv.callsign AS inviter_callsign, inv.avatar_url AS inviter_avatar
            FROM group_members gm LEFT JOIN members inv ON inv.public_key = gm.invited_by
            WHERE gm.group_id = ? AND gm.member_pubkey = ?
        `).get(row.id, viewerPubkey) as any;
        if (membership) {
            // A removed row is a record, not a membership: no role, so no app lists it among "your groups".
            viewerRole = membership.status === 'removed' ? undefined : membership.role as GroupRole;
            viewerStatus = membership.status as GroupMemberStatus;
            // Who asked them, for the invite landing (groups slice 2). Only ever the viewer's own invitation.
            if (membership.status === 'invited' && membership.invited_by) {
                viewerInvitedBy = {
                    pubkey: membership.invited_by,
                    callsign: membership.inviter_callsign || undefined,
                    avatarUrl: membership.inviter_avatar || undefined,
                };
            }
        }
    }

    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description || undefined,
        avatarUrl: row.avatar_url || undefined,
        category: row.category as GroupCategory,
        createdBy: row.created_by,
        joinPolicy: row.join_policy as JoinPolicy,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        memberCount: row.member_count ?? 0,
        convenorPubkey: row.convenor_pubkey || undefined,
        convenorCallsign: row.convenor_callsign || undefined,
        convenorAvatarUrl: row.convenor_avatar_url || undefined,
        leadPubkey: row.convenor_pubkey || null,
        leadCallsign: row.convenor_callsign || undefined,
        viewerRole,
        viewerStatus,
        viewerInvitedBy,
    };
}

export function listGroups(db: Db, filter?: ListGroupsFilter, viewerPubkey?: string): Group[] {
    let query = `
        SELECT g.*,
               (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.status = 'active') as member_count,
               ${leadPubkeySql('g')} as convenor_pubkey,
               m.callsign as convenor_callsign,
               m.avatar_url as convenor_avatar_url
        FROM groups g
        LEFT JOIN members m ON m.public_key = ${leadPubkeySql('g')}
        WHERE 1=1
    `;
    const params: any[] = [];

    // An invite_only group is not advertised. The broadcast path already treats non-open groups as private
    // (state-engine.ts scopes group_created/group_updated to active members); without this the fetch path
    // contradicted it, handing every private group's name, description, member count and convenor to anyone
    // who asked. open and request_to_join stay listed for everyone — a request_to_join group nobody can see
    // is a group nobody can ask to join.
    if (viewerPubkey) {
        query += " AND (g.join_policy != 'invite_only' OR EXISTS (SELECT 1 FROM group_members gmv WHERE gmv.group_id = g.id AND gmv.member_pubkey = ? AND gmv.status != 'removed'))";
        params.push(viewerPubkey);
    } else {
        query += " AND g.join_policy != 'invite_only'";
    }

    if (filter?.memberPubkey) {
        query += " AND g.id IN (SELECT group_id FROM group_members WHERE member_pubkey = ? AND status = 'active')";
        params.push(filter.memberPubkey);
    }

    if (filter?.category && filter.category !== 'all') {
        query += " AND g.category = ?";
        params.push(filter.category);
    }

    if (filter?.query && filter.query.trim()) {
        query += " AND (g.name LIKE ? OR g.description LIKE ?)";
        const term = `%${filter.query.trim()}%`;
        params.push(term, term);
    }

    query += " ORDER BY g.updated_at DESC, g.created_at DESC";

    if (filter?.limit) {
        query += " LIMIT ? OFFSET ?";
        params.push(filter.limit, filter.offset || 0);
    }

    const rows = db.prepare(query).all(...params) as any[];
    if (rows.length === 0) return [];

    const groupIds = rows.map(r => r.id);
    const viewerMap = new Map<string, { role: GroupRole | undefined; status: GroupMemberStatus }>();
    if (viewerPubkey && groupIds.length > 0) {
        const placeholders = groupIds.map(() => '?').join(',');
        const memberships = db.prepare(
            `SELECT group_id, role, status FROM group_members WHERE member_pubkey = ? AND group_id IN (${placeholders})`
        ).all(viewerPubkey, ...groupIds) as any[];
        for (const m of memberships) {
            viewerMap.set(m.group_id, {
                role: m.status === 'removed' ? undefined : m.role as GroupRole,
                status: m.status as GroupMemberStatus,
            });
        }
    }

    return rows.map(row => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description || undefined,
        avatarUrl: row.avatar_url || undefined,
        category: row.category as GroupCategory,
        createdBy: row.created_by,
        joinPolicy: row.join_policy as JoinPolicy,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        memberCount: row.member_count ?? 0,
        convenorPubkey: row.convenor_pubkey || undefined,
        convenorCallsign: row.convenor_callsign || undefined,
        convenorAvatarUrl: row.convenor_avatar_url || undefined,
        leadPubkey: row.convenor_pubkey || null,
        leadCallsign: row.convenor_callsign || undefined,
        viewerRole: viewerMap.get(row.id)?.role,
        viewerStatus: viewerMap.get(row.id)?.status
    }));
}

export function getGroupMembers(db: Db, groupId: string, filter?: { status?: GroupMemberStatus; role?: GroupRole }): GroupMember[] {
    let query = `
        SELECT gm.*, m.callsign, m.avatar_url
        FROM group_members gm
        LEFT JOIN members m ON m.public_key = gm.member_pubkey
        WHERE gm.group_id = ?
    `;
    const params: any[] = [groupId];

    if (filter?.status) {
        query += " AND gm.status = ?";
        params.push(filter.status);
    } else {
        // Unfiltered means "everyone with a live relationship to the group": members, requests, invitations.
        // Removed people are only listed when asked for by name.
        query += " AND gm.status != 'removed'";
    }

    if (filter?.role) {
        query += " AND gm.role = ?";
        params.push(filter.role);
    }

    query += `
        ORDER BY
            CASE gm.role
                WHEN 'convenor' THEN 1
                WHEN 'member' THEN 2
                WHEN 'observer' THEN 3
                ELSE 4
            END,
            gm.joined_at ASC
    `;

    const rows = db.prepare(query).all(...params) as any[];
    return rows.map(r => ({
        groupId: r.group_id,
        memberPubkey: r.member_pubkey,
        role: r.role as GroupRole,
        status: r.status as GroupMemberStatus,
        joinedAt: r.joined_at,
        invitedBy: r.invited_by || undefined,
        updatedAt: r.updated_at,
        callsign: r.callsign || undefined,
        avatarUrl: r.avatar_url || undefined
    }));
}

export function getGroupMember(db: Db, groupId: string, memberPubkey: string): GroupMember | null {
    const row = db.prepare(`
        SELECT gm.*, m.callsign, m.avatar_url
        FROM group_members gm
        LEFT JOIN members m ON m.public_key = gm.member_pubkey
        WHERE gm.group_id = ? AND gm.member_pubkey = ?
    `).get(groupId, memberPubkey) as any;

    if (!row) return null;
    return {
        groupId: row.group_id,
        memberPubkey: row.member_pubkey,
        role: row.role as GroupRole,
        status: row.status as GroupMemberStatus,
        joinedAt: row.joined_at,
        invitedBy: row.invited_by || undefined,
        updatedAt: row.updated_at,
        callsign: row.callsign || undefined,
        avatarUrl: row.avatar_url || undefined
    };
}

// ===================== THE LEAD CONVENOR =====================

/**
 * The group's lead convenor, as SQL. `g` is the alias of the `groups` row in scope.
 *
 * The stored `lead_pubkey` wins while it still names an ACTIVE CONVENOR of the group. When it does not — the
 * column has never been backfilled, the row arrived from a node older than this change, or the lead's membership
 * went away with their account — the same rule the backfill uses decides: the creator while they are an active
 * convenor, otherwise the longest-serving active convenor. So the answer never depends on whether a particular
 * node has run the migration, and a stale pointer can never be read as a live lead.
 *
 * Three COALESCE branches rather than one ORDER BY that prefers the creator, because SQLite resolves a
 * subquery's ORDER BY against that subquery's own FROM clause: `g.created_by` is not visible there.
 */
const leadPubkeySql = (g: string) => `COALESCE(
    (SELECT gml.member_pubkey FROM group_members gml
      WHERE gml.group_id = ${g}.id AND gml.member_pubkey = ${g}.lead_pubkey
        AND gml.role = 'convenor' AND gml.status = 'active'),
    (SELECT gmc.member_pubkey FROM group_members gmc
      WHERE gmc.group_id = ${g}.id AND gmc.member_pubkey = ${g}.created_by
        AND gmc.role = 'convenor' AND gmc.status = 'active'),
    (SELECT gmf.member_pubkey FROM group_members gmf
      WHERE gmf.group_id = ${g}.id AND gmf.role = 'convenor' AND gmf.status = 'active'
      ORDER BY gmf.joined_at ASC, gmf.member_pubkey ASC
      LIMIT 1)
)`;

/** Who leads this group, or null when it has no active convenor at all. */
export function getGroupLead(db: Db, groupId: string): string | null {
    const row = db.prepare(`SELECT ${leadPubkeySql('g')} AS lead FROM groups g WHERE g.id = ?`).get(groupId) as any;
    return row?.lead || null;
}

export function isGroupLead(db: Db, groupId: string, memberPubkey: string): boolean {
    if (!groupId || !memberPubkey) return false;
    return getGroupLead(db, groupId) === memberPubkey;
}

/**
 * Write down whoever leads the group now, so `lead_pubkey` stops pointing at someone who is no longer an active
 * convenor. Called after any change that could move the lead — a removal, a role change, a membership that
 * vanished with an account. Returns the lead. Writing NULL is right and deliberate: a group with no active
 * convenor has no lead, and gains one again through the same fallback the moment it has a convenor.
 */
export function reconcileGroupLead(db: Db, groupId: string): string | null {
    const lead = getGroupLead(db, groupId);
    const stored = (db.prepare('SELECT lead_pubkey FROM groups WHERE id = ?').get(groupId) as any)?.lead_pubkey ?? null;
    if (stored === lead) return lead;
    db.prepare('UPDATE groups SET lead_pubkey = ?, updated_at = ? WHERE id = ?')
        .run(lead, new Date().toISOString(), groupId);
    return lead;
}

/** How many OTHER people are still active in the group — what decides whether a lead may just leave. */
function otherActiveMemberCount(db: Db, groupId: string, memberPubkey: string): number {
    return ((db.prepare(
        "SELECT COUNT(*) AS c FROM group_members WHERE group_id = ? AND status = 'active' AND member_pubkey != ?"
    ).get(groupId, memberPubkey) as any)?.c ?? 0) as number;
}

export const HAND_OVER_FIRST =
    'You are this group\'s lead convenor. Hand the lead over to someone else first.';

/**
 * What a convenor refused by the lead rules can actually do. It names only routes that exist today: the hand-over,
 * and the 30-day-silence vote (apps/server/src/engine/group-succession.ts). No Decision effect names a group's
 * lead as its subject, so the text must not send anyone looking for one — see docs/the-commons.md, "A suspended
 * lead is still the lead".
 */
export const LEAD_SILENCE_VOTE =
    "Otherwise, 30 days after the lead's last activity, the other convenors — or the members, if the lead is the group's only convenor — can vote a replacement in.";

/**
 * The lead hands the lead on: to another active convenor, or to an active member, who becomes a convenor in the
 * same step. The outgoing lead stays a convenor — handing over is not leaving.
 */
export function handOverGroupLead(db: Db, groupId: string, leadPubkey: string, targetPubkey: string): GroupMember {
    const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId) as any;
    if (!group) throw new Error('Group not found');
    if (!isGroupLead(db, groupId, leadPubkey)) {
        throw new Error('UNAUTHORIZED: Only the lead convenor can hand the lead over');
    }
    if (leadPubkey === targetPubkey) throw new Error('You already lead this group');

    const target = getGroupMember(db, groupId, targetPubkey);
    if (!target || target.status !== 'active') {
        throw new Error('The new lead convenor must be an active member of this group');
    }
    if (target.role === 'observer') {
        throw new Error('An observer only watches this group. Make them a member or a convenor first.');
    }

    const now = membershipWriteAt(db, groupId, targetPubkey);
    db.transaction(() => {
        if (target.role !== 'convenor') {
            db.prepare("UPDATE group_members SET role = 'convenor', updated_at = ? WHERE group_id = ? AND member_pubkey = ?")
                .run(now, groupId, targetPubkey);
        }
        db.prepare('UPDATE groups SET lead_pubkey = ?, updated_at = ? WHERE id = ?')
            .run(targetPubkey, new Date().toISOString(), groupId);
    })();

    return getGroupMember(db, groupId, targetPubkey)!;
}

export function isGroupConvenor(db: Db, groupId: string, memberPubkey: string): boolean {
    if (!groupId || !memberPubkey) return false;
    const row = db.prepare(
        "SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND role = 'convenor' AND status = 'active'"
    ).get(groupId, memberPubkey);
    return !!row;
}

export function isGroupMember(db: Db, groupId: string, memberPubkey: string): boolean {
    if (!groupId || !memberPubkey) return false;
    const row = db.prepare(
        "SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active'"
    ).get(groupId, memberPubkey);
    return !!row;
}

export function getMemberGroupIds(db: Db, memberPubkey: string): string[] {
    if (!memberPubkey) return [];
    const rows = db.prepare(
        "SELECT group_id FROM group_members WHERE member_pubkey = ? AND status = 'active'"
    ).all(memberPubkey) as any[];
    return rows.map(r => r.group_id);
}

/**
 * The next timestamp strictly after everything already written for one membership row — its updated_at and
 * any tombstone left when the member last left. Someone who leaves and rejoins inside one millisecond would
 * otherwise leave a row and a tombstone stamped identically, and a replica importing both would drop the
 * re-join. The same rule the event chat uses (apps/server/src/engine/event-thread.ts membershipWriteAt).
 */
function membershipWriteAt(db: Db, groupId: string, memberPubkey: string): string {
    const nowIso = new Date().toISOString();
    let prev: string | null = null;
    try {
        prev = (db.prepare(`
            SELECT MAX(ts) AS ts FROM (
                SELECT updated_at AS ts FROM group_members WHERE group_id = ? AND member_pubkey = ?
                UNION ALL
                SELECT deleted_at AS ts FROM tombstones WHERE table_name = 'group_members' AND row_key = ?
            )`).get(groupId, memberPubkey, `${groupId}|${memberPubkey}`) as { ts: string | null } | undefined)?.ts ?? null;
    } catch {
        // No tombstones table (engine-only fixtures): the row alone decides.
        prev = (db.prepare('SELECT updated_at AS ts FROM group_members WHERE group_id = ? AND member_pubkey = ?')
            .get(groupId, memberPubkey) as { ts: string | null } | undefined)?.ts ?? null;
    }
    return prev && prev >= nowIso ? new Date(Date.parse(prev) + 1).toISOString() : nowIso;
}

export function joinGroup(db: Db, groupId: string, memberPubkey: string): GroupMember {
    const group = db.prepare("SELECT id, join_policy FROM groups WHERE id = ?").get(groupId) as any;
    if (!group) throw new Error('Group not found');

    const member = db.prepare("SELECT public_key, status FROM members WHERE public_key = ?").get(memberPubkey) as any;
    if (!member || member.status === 'pruned') throw new Error('Member not found or pruned');

    const existing = db.prepare("SELECT * FROM group_members WHERE group_id = ? AND member_pubkey = ?").get(groupId, memberPubkey) as any;

    const now = membershipWriteAt(db, groupId, memberPubkey);

    if (existing) {
        if (existing.status === 'active') {
            return getGroupMember(db, groupId, memberPubkey)!;
        }
        if (existing.status === 'pending_approval') {
            throw new Error('Membership request already pending');
        }
        if (existing.status === 'removed') {
            throw new Error('A convenor removed you from this group. Only a convenor can add you back.');
        }
        if (existing.status === 'invited') {
            // Accepting an invitation
            db.prepare(
                "UPDATE group_members SET status = 'active', updated_at = ? WHERE group_id = ? AND member_pubkey = ?"
            ).run(now, groupId, memberPubkey);
            return getGroupMember(db, groupId, memberPubkey)!;
        }
    }

    if (group.join_policy === 'open') {
        db.prepare(`
            INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at)
            VALUES (?, ?, 'member', 'active', ?, ?)
        `).run(groupId, memberPubkey, now, now);
    } else if (group.join_policy === 'request_to_join') {
        db.prepare(`
            INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at)
            VALUES (?, ?, 'member', 'pending_approval', ?, ?)
        `).run(groupId, memberPubkey, now, now);
    } else if (group.join_policy === 'invite_only') {
        throw new Error('This group is invite only. You must be invited by a convenor.');
    } else {
        throw new Error(`Unknown join policy: ${group.join_policy}`);
    }

    return getGroupMember(db, groupId, memberPubkey)!;
}

// ===================== CONVENOR MODERATION =====================

export function setMemberRole(db: Db, groupId: string, convenorPubkey: string, targetPubkey: string, newRole: GroupRole): GroupMember {
    if (!isGroupConvenor(db, groupId, convenorPubkey)) {
        throw new Error('UNAUTHORIZED: Only a group convenor can change member roles');
    }
    if (!isGroupRole(newRole)) {
        throw new Error(`Invalid group role: ${newRole}`);
    }

    const target = getGroupMember(db, groupId, targetPubkey);
    if (!target || target.status === 'removed') {
        throw new Error('Target is not a member of this group');
    }

    // The lead convenor. Nobody demotes them — a convenor who thinks they should go has the 30-day-silence vote,
    // and nothing else: no Decision effect names a group's lead. The lead themselves hands the lead over first.
    const lead = getGroupLead(db, groupId);
    const isSelf = convenorPubkey === targetPubkey;
    if (lead && targetPubkey === lead && newRole !== 'convenor') {
        throw new Error(isSelf
            ? `UNAUTHORIZED: ${HAND_OVER_FIRST}`
            : `UNAUTHORIZED: The group's lead convenor cannot be demoted. The lead can hand the lead over. ${LEAD_SILENCE_VOTE}`);
    }
    // Only the lead may touch another convenor. A convenor may still step down from convenor themselves.
    if (target.role === 'convenor' && target.status === 'active' && newRole !== 'convenor'
        && !isSelf && convenorPubkey !== lead) {
        throw new Error("UNAUTHORIZED: Only this group's lead convenor can change another convenor's role");
    }

    // Safety: Cannot demote the last convenor
    if (target.role === 'convenor' && newRole !== 'convenor') {
        const activeConvenors = db.prepare(
            "SELECT COUNT(*) as c FROM group_members WHERE group_id = ? AND role = 'convenor' AND status = 'active' AND member_pubkey != ?"
        ).get(groupId, targetPubkey) as any;
        if ((activeConvenors?.c || 0) === 0) {
            throw new Error('Cannot demote the last active convenor of a group');
        }
    }

    const now = membershipWriteAt(db, groupId, targetPubkey);
    db.prepare(
        "UPDATE group_members SET role = ?, updated_at = ? WHERE group_id = ? AND member_pubkey = ?"
    ).run(newRole, now, groupId, targetPubkey);
    // Pin down whoever leads the group now. It changes nothing for a group whose lead is already stored; it
    // settles the fallback for one whose lead_pubkey has never been written, so a later promotion cannot quietly
    // move the lead to whoever happens to have joined earliest.
    reconcileGroupLead(db, groupId);

    return getGroupMember(db, groupId, targetPubkey)!;
}

export function removeGroupMember(db: Db, groupId: string, actorPubkey: string, targetPubkey: string): boolean {
    const isConvenor = isGroupConvenor(db, groupId, actorPubkey);
    const isSelf = actorPubkey === targetPubkey;

    if (!isConvenor && !isSelf) {
        throw new Error('UNAUTHORIZED: Only a group convenor can remove members, or a member may leave themselves');
    }

    const target = getGroupMember(db, groupId, targetPubkey);
    if (!target) return false;
    // Already removed: nothing to do — and "leaving" must not erase the record and reopen the door.
    if (target.status === 'removed') return false;

    const lead = getGroupLead(db, groupId);
    if (lead && targetPubkey === lead) {
        // The lead leaves by handing over first; until then there is no route out of the group for them, and no
        // route by which anyone else can push them out. That is the point of the lead.
        if (!isSelf) {
            throw new Error(`UNAUTHORIZED: The group's lead convenor cannot be removed. The lead can hand the lead over and leave. ${LEAD_SILENCE_VOTE}`);
        }
        if (otherActiveMemberCount(db, groupId, targetPubkey) > 0) {
            throw new Error(HAND_OVER_FIRST);
        }
        // Last one out: nobody is left to hand the lead to, so the lead may simply go.
    } else if (!isSelf && target.role === 'convenor' && target.status === 'active' && actorPubkey !== lead) {
        throw new Error("UNAUTHORIZED: Only this group's lead convenor can remove another convenor");
    }

    // Safety: Cannot remove the last active convenor if other active members exist
    if (target.role === 'convenor' && target.status === 'active') {
        const otherConvenors = db.prepare(
            "SELECT COUNT(*) as c FROM group_members WHERE group_id = ? AND role = 'convenor' AND status = 'active' AND member_pubkey != ?"
        ).get(groupId, targetPubkey) as any;
        const otherMembers = db.prepare(
            "SELECT COUNT(*) as c FROM group_members WHERE group_id = ? AND status = 'active' AND member_pubkey != ?"
        ).get(groupId, targetPubkey) as any;

        if ((otherConvenors?.c || 0) === 0 && (otherMembers?.c || 0) > 0) {
            throw new Error('Cannot remove the last active convenor while other active members remain');
        }
    }

    const now = membershipWriteAt(db, groupId, targetPubkey);

    // Deleting the row (with a tombstone for backups) means the person can come back. That is right for someone who
    // leaves on their own, and ALSO for a convenor declining a request or withdrawing an invitation: that person was
    // never in the group, so barring them for good — and telling them "a convenor removed you" — would be false, and no
    // screen exists to undo it. Only removing an ACTIVE member sticks.
    if (isSelf || target.status !== 'active') {
        // Leaving (or withdrawing a request, or declining an invitation) deletes the row, so someone who left can
        // come back to an open group. The tombstone carries the delete to backups; a later re-join is stamped
        // after it and wins.
        let deleted = false;
        db.transaction(() => {
            const res = db.prepare("DELETE FROM group_members WHERE group_id = ? AND member_pubkey = ?").run(groupId, targetPubkey);
            if (res.changes === 0) return;
            deleted = true;
            db.prepare(
                "INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at) VALUES ('group_members', ?, ?)"
            ).run(`${groupId}|${targetPubkey}`, now);
        })();
        if (deleted) reconcileGroupLead(db, groupId);
        return deleted;
    }

    // A convenor removing someone else keeps the row as 'removed', so the removal sticks: joinGroup refuses them
    // and only a convenor can re-admit them (invite or approve). The role drops to member so re-admission never
    // quietly restores convenor powers.
    const res = db.prepare(
        "UPDATE group_members SET status = 'removed', role = 'member', updated_at = ? WHERE group_id = ? AND member_pubkey = ?"
    ).run(now, groupId, targetPubkey);
    if (res.changes > 0) reconcileGroupLead(db, groupId);
    return res.changes > 0;
}

export function updateGroupPolicy(db: Db, groupId: string, convenorPubkey: string, joinPolicy: JoinPolicy): Group {
    if (!isGroupConvenor(db, groupId, convenorPubkey)) {
        throw new Error('UNAUTHORIZED: Only a group convenor can change the group join policy');
    }
    if (!isJoinPolicy(joinPolicy)) {
        throw new Error(`Invalid join policy: ${joinPolicy}`);
    }

    const now = new Date().toISOString();
    db.prepare("UPDATE groups SET join_policy = ?, updated_at = ? WHERE id = ?").run(joinPolicy, now, groupId);

    const updated = getGroup(db, groupId, convenorPubkey);
    if (!updated) throw new Error('Group not found');
    return updated;
}

export function updateGroup(db: Db, groupId: string, convenorPubkey: string, updates: UpdateGroupParams): Group {
    if (!isGroupConvenor(db, groupId, convenorPubkey)) {
        throw new Error('UNAUTHORIZED: Only a group convenor can update group details');
    }

    const sets: string[] = [];
    const params: any[] = [];

    if (updates.name !== undefined) {
        const name = updates.name.trim();
        if (name.length < 1 || name.length > 100) {
            throw new Error('Group name must be between 1 and 100 characters');
        }
        sets.push('name = ?');
        params.push(name);
    }

    if (updates.description !== undefined) {
        sets.push('description = ?');
        params.push(updates.description.trim() || null);
    }

    if (updates.avatarUrl !== undefined) {
        sets.push('avatar_url = ?');
        params.push(updates.avatarUrl || null);
    }

    if (updates.category !== undefined) {
        if (!isGroupCategory(updates.category)) {
            throw new Error(`Invalid group category: ${updates.category}`);
        }
        sets.push('category = ?');
        params.push(updates.category);
    }

    if (updates.joinPolicy !== undefined) {
        if (!isJoinPolicy(updates.joinPolicy)) {
            throw new Error(`Invalid join policy: ${updates.joinPolicy}`);
        }
        sets.push('join_policy = ?');
        params.push(updates.joinPolicy);
    }

    if (sets.length === 0) {
        return getGroup(db, groupId, convenorPubkey)!;
    }

    const now = new Date().toISOString();
    sets.push('updated_at = ?');
    params.push(now, groupId);

    db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = getGroup(db, groupId, convenorPubkey);
    if (!updated) throw new Error('Group not found');
    return updated;
}

export function approveGroupMember(db: Db, groupId: string, convenorPubkey: string, targetPubkey: string): GroupMember {
    if (!isGroupConvenor(db, groupId, convenorPubkey)) {
        throw new Error('UNAUTHORIZED: Only a group convenor can approve member join requests');
    }

    const target = getGroupMember(db, groupId, targetPubkey);
    if (!target) {
        throw new Error('Membership request not found');
    }
    if (target.status === 'active') {
        return target;
    }

    const now = membershipWriteAt(db, groupId, targetPubkey);
    db.prepare(
        "UPDATE group_members SET status = 'active', updated_at = ? WHERE group_id = ? AND member_pubkey = ?"
    ).run(now, groupId, targetPubkey);

    return getGroupMember(db, groupId, targetPubkey)!;
}

export function inviteGroupMember(db: Db, groupId: string, convenorPubkey: string, targetPubkey: string, role: GroupRole = 'member'): GroupMember {
    if (!isGroupConvenor(db, groupId, convenorPubkey)) {
        throw new Error('UNAUTHORIZED: Only a group convenor can invite members to this group');
    }
    if (!isGroupRole(role)) {
        throw new Error(`Invalid group role: ${role}`);
    }

    const member = db.prepare("SELECT public_key, status FROM members WHERE public_key = ?").get(targetPubkey) as any;
    if (!member || member.status === 'pruned') throw new Error('Invited member not found or pruned');

    const existing = getGroupMember(db, groupId, targetPubkey);
    const now = membershipWriteAt(db, groupId, targetPubkey);

    if (existing) {
        if (existing.status === 'active') {
            return existing;
        }
        if (existing.status === 'pending_approval') {
            // Direct approve
            db.prepare(
                "UPDATE group_members SET status = 'active', role = ?, invited_by = ?, updated_at = ? WHERE group_id = ? AND member_pubkey = ?"
            ).run(role, convenorPubkey, now, groupId, targetPubkey);
            return getGroupMember(db, groupId, targetPubkey)!;
        }
        if (existing.status === 'invited') {
            return existing;
        }
        if (existing.status === 'removed') {
            // Re-admission: an invitation they still have to accept, like any other.
            db.prepare(
                "UPDATE group_members SET status = 'invited', role = ?, invited_by = ?, joined_at = ?, updated_at = ? WHERE group_id = ? AND member_pubkey = ?"
            ).run(role, convenorPubkey, now, now, groupId, targetPubkey);
            return getGroupMember(db, groupId, targetPubkey)!;
        }
    }

    db.prepare(`
        INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, invited_by, updated_at)
        VALUES (?, ?, ?, 'invited', ?, ?, ?)
    `).run(groupId, targetPubkey, role, now, convenorPubkey, now);

    return getGroupMember(db, groupId, targetPubkey)!;
}

export function deleteGroupPost(db: Db, groupId: string, convenorPubkey: string, postId: string): boolean {
    if (!isGroupConvenor(db, groupId, convenorPubkey)) {
        throw new Error('UNAUTHORIZED: Only a group convenor can moderate posts in this group');
    }

    const post = db.prepare("SELECT id, target_group_id, audience_scope, active FROM posts WHERE id = ?").get(postId) as any;
    if (!post) return false;

    if (post.audience_scope !== 'group' || post.target_group_id !== groupId) {
        throw new Error('Post does not belong to this group');
    }

    const pendingTx = db.prepare(
        "SELECT COUNT(*) as c FROM marketplace_transactions WHERE post_id = ? AND status = 'pending'"
    ).get(postId) as any;
    if (pendingTx && pendingTx.c > 0) {
        throw new Error('This post has a deal in escrow — complete or cancel the deal before deleting it');
    }

    let removed = false;
    db.transaction(() => {
        const result = db.prepare(
            "UPDATE posts SET active = 0, status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND target_group_id = ? AND audience_scope = 'group'"
        ).run(postId, groupId);
        if (result.changes === 0) return;
        removed = true;
        db.prepare(
            "UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND status='requested'"
        ).run(postId);
        db.prepare(
            "UPDATE deferred_wage_claims SET status = 'cancelled' WHERE post_id = ? AND status = 'pending'"
        ).run(postId);
    })();

    return removed;
}
