// Groups, convenor moderation, and group membership engine.
// Docs: docs/the-commons.md §9 (Item 10)
//
// A group is an audience scope and NOTHING else:
// - It holds no money, grants no trust, confers no node role, and is never linked to an enterprise.
// - Separate role table: group_members (convenor | member | observer).
// - Join policies: open | request_to_join | invite_only.

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
    isGroupMemberStatus
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

export function ensureUniqueSlug(db: Db, baseSlug: string, existingGroupId?: string): string {
    let slug = baseSlug;
    let count = 1;
    while (true) {
        const row = db.prepare("SELECT id FROM groups WHERE slug = ?").get(slug) as any;
        if (!row || (existingGroupId && row.id === existingGroupId)) {
            return slug;
        }
        count++;
        slug = `${baseSlug.slice(0, 44)}-${count}`;
    }
}

export function createGroup(db: Db, params: CreateGroupParams): Group {
    const trimmedName = params.name?.trim();
    if (!trimmedName || trimmedName.length < 1 || trimmedName.length > 100) {
        throw new Error('Group name must be between 1 and 100 characters');
    }

    const category: GroupCategory = params.category ?? 'general';
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
            INSERT INTO groups (id, name, slug, description, avatar_url, category, created_by, join_policy, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            trimmedName,
            slug,
            params.description?.trim() || null,
            params.avatarUrl || null,
            category,
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
    const row = db.prepare(`
        SELECT g.*,
               (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.status = 'active') as member_count,
               (SELECT gm.member_pubkey FROM group_members gm WHERE gm.group_id = g.id AND gm.role = 'convenor' AND gm.status = 'active' ORDER BY gm.joined_at ASC LIMIT 1) as convenor_pubkey,
               m.callsign as convenor_callsign,
               m.avatar_url as convenor_avatar_url
        FROM groups g
        LEFT JOIN members m ON m.public_key = (
            SELECT gm2.member_pubkey FROM group_members gm2 WHERE gm2.group_id = g.id AND gm2.role = 'convenor' AND gm2.status = 'active' ORDER BY gm2.joined_at ASC LIMIT 1
        )
        WHERE g.id = ? OR g.slug = ?
    `).get(idOrSlug, idOrSlug) as any;

    if (!row) return null;

    let viewerRole: GroupRole | undefined;
    let viewerStatus: GroupMemberStatus | undefined;
    if (viewerPubkey) {
        const membership = db.prepare(
            "SELECT role, status FROM group_members WHERE group_id = ? AND member_pubkey = ?"
        ).get(row.id, viewerPubkey) as any;
        if (membership) {
            viewerRole = membership.role as GroupRole;
            viewerStatus = membership.status as GroupMemberStatus;
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
        viewerRole,
        viewerStatus
    };
}

export function listGroups(db: Db, filter?: ListGroupsFilter, viewerPubkey?: string): Group[] {
    let query = `
        SELECT g.*,
               (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.status = 'active') as member_count,
               (SELECT gm.member_pubkey FROM group_members gm WHERE gm.group_id = g.id AND gm.role = 'convenor' AND gm.status = 'active' ORDER BY gm.joined_at ASC LIMIT 1) as convenor_pubkey,
               m.callsign as convenor_callsign,
               m.avatar_url as convenor_avatar_url
        FROM groups g
        LEFT JOIN members m ON m.public_key = (
            SELECT gm2.member_pubkey FROM group_members gm2 WHERE gm2.group_id = g.id AND gm2.role = 'convenor' AND gm2.status = 'active' ORDER BY gm2.joined_at ASC LIMIT 1
        )
        WHERE 1=1
    `;
    const params: any[] = [];

    // An invite_only group is not advertised. The broadcast path already treats non-open groups as private
    // (state-engine.ts scopes group_created/group_updated to active members); without this the fetch path
    // contradicted it, handing every private group's name, description, member count and convenor to anyone
    // who asked. open and request_to_join stay listed for everyone — a request_to_join group nobody can see
    // is a group nobody can ask to join.
    if (viewerPubkey) {
        query += " AND (g.join_policy != 'invite_only' OR EXISTS (SELECT 1 FROM group_members gmv WHERE gmv.group_id = g.id AND gmv.member_pubkey = ?))";
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
    const viewerMap = new Map<string, { role: GroupRole; status: GroupMemberStatus }>();
    if (viewerPubkey && groupIds.length > 0) {
        const placeholders = groupIds.map(() => '?').join(',');
        const memberships = db.prepare(
            `SELECT group_id, role, status FROM group_members WHERE member_pubkey = ? AND group_id IN (${placeholders})`
        ).all(viewerPubkey, ...groupIds) as any[];
        for (const m of memberships) {
            viewerMap.set(m.group_id, { role: m.role as GroupRole, status: m.status as GroupMemberStatus });
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

export function joinGroup(db: Db, groupId: string, memberPubkey: string): GroupMember {
    const group = db.prepare("SELECT id, join_policy FROM groups WHERE id = ?").get(groupId) as any;
    if (!group) throw new Error('Group not found');

    const member = db.prepare("SELECT public_key, status FROM members WHERE public_key = ?").get(memberPubkey) as any;
    if (!member || member.status === 'pruned') throw new Error('Member not found or pruned');

    const existing = db.prepare("SELECT * FROM group_members WHERE group_id = ? AND member_pubkey = ?").get(groupId, memberPubkey) as any;

    const now = new Date().toISOString();

    if (existing) {
        if (existing.status === 'active') {
            return getGroupMember(db, groupId, memberPubkey)!;
        }
        if (existing.status === 'pending_approval') {
            throw new Error('Membership request already pending');
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
    if (!target) {
        throw new Error('Target is not a member of this group');
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

    const now = new Date().toISOString();
    db.prepare(
        "UPDATE group_members SET role = ?, updated_at = ? WHERE group_id = ? AND member_pubkey = ?"
    ).run(newRole, now, groupId, targetPubkey);

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

    const res = db.prepare("DELETE FROM group_members WHERE group_id = ? AND member_pubkey = ?").run(groupId, targetPubkey);
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

    const now = new Date().toISOString();
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
    const now = new Date().toISOString();

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
