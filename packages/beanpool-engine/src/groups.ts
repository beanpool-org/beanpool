// Pure database operations for Groups, Working Groups & Enterprise Teams.
//
// Every function here takes a better-sqlite3 `Database` handle as its first argument.

import type Database from 'better-sqlite3';
import {
    type Group,
    type GroupMember,
    type GroupRole,
    type JoinPolicy,
    type GroupCategory,
    type GroupMemberStatus,
    isValidGroupRole,
    isValidJoinPolicy,
    isValidGroupCategory
} from '@beanpool/core';
import crypto from 'node:crypto';

type Db = Database.Database;

export function slugify(text: string): string {
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')           // Replace spaces with -
        .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
        .replace(/\-\-+/g, '-')         // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start of text
        .replace(/-+$/, '');            // Trim - from end of text
}

export interface CreateGroupParams {
    id?: string;
    name: string;
    slug?: string;
    description?: string;
    avatarUrl?: string | null;
    category?: GroupCategory;
    createdBy: string;
    joinPolicy?: JoinPolicy;
    isOfficial?: boolean;
    treasuryPubkey?: string | null;
    conversationId?: string | null;
}

export function createGroup(db: Db, params: CreateGroupParams): Group {
    const name = params.name?.trim();
    if (!name || name.length < 2) {
        throw new Error('Group name must be at least 2 characters long');
    }
    if (!params.createdBy) {
        throw new Error('createdBy public key is required');
    }

    const id = params.id || crypto.randomUUID();
    let baseSlug = params.slug ? slugify(params.slug) : slugify(name);
    if (!baseSlug) baseSlug = 'group';

    // Ensure unique slug
    let slug = baseSlug;
    let counter = 1;
    while (true) {
        const existing = db.prepare('SELECT id FROM groups WHERE slug = ?').get(slug);
        if (!existing) break;
        slug = `${baseSlug}-${counter++}`;
    }

    const category = isValidGroupCategory(params.category) ? params.category : 'general';
    const joinPolicy = isValidJoinPolicy(params.joinPolicy) ? params.joinPolicy : 'open';
    const isOfficial = params.isOfficial ? 1 : 0;
    const now = new Date().toISOString();

    db.transaction(() => {
        db.prepare(`
            INSERT INTO groups (
                id, name, slug, description, avatar_url, category,
                created_by, join_policy, is_official, treasury_pubkey,
                conversation_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            name,
            slug,
            params.description?.trim() || null,
            params.avatarUrl || null,
            category,
            params.createdBy,
            joinPolicy,
            isOfficial,
            params.treasuryPubkey || null,
            params.conversationId || null,
            now,
            now
        );

        // Creator automatically becomes an active Steward
        db.prepare(`
            INSERT INTO group_members (
                group_id, member_pubkey, role, status, joined_at, updated_at
            ) VALUES (?, ?, 'steward', 'active', ?, ?)
        `).run(id, params.createdBy, now, now);
    })();

    return getGroup(db, id, params.createdBy)!;
}

export function getGroup(db: Db, idOrSlug: string, viewerPubkey?: string): Group | null {
    const row = db.prepare(`
        SELECT g.*,
               (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.status = 'active') as member_count,
               (SELECT COUNT(*) FROM posts p WHERE p.target_group_id = g.id AND p.type = 'need' AND p.active = 1 AND p.status = 'active') as open_needs_count
        FROM groups g
        WHERE g.id = ? OR g.slug = ?
    `).get(idOrSlug, idOrSlug) as any;

    if (!row) return null;

    let currentUserRole: GroupRole | null = null;
    let currentUserStatus: GroupMemberStatus | null = null;

    if (viewerPubkey) {
        const memberRow = db.prepare(`
            SELECT role, status FROM group_members
            WHERE group_id = ? AND member_pubkey = ?
        `).get(row.id, viewerPubkey) as any;

        if (memberRow) {
            currentUserRole = memberRow.role as GroupRole;
            currentUserStatus = memberRow.status as GroupMemberStatus;
        }
    }

    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description || undefined,
        avatarUrl: row.avatar_url || null,
        category: row.category as GroupCategory,
        createdBy: row.created_by,
        joinPolicy: row.join_policy as JoinPolicy,
        isOfficial: Boolean(row.is_official),
        treasuryPubkey: row.treasury_pubkey || null,
        conversationId: row.conversation_id || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at || row.created_at,
        memberCount: row.member_count || 0,
        openNeedsCount: row.open_needs_count || 0,
        currentUserRole,
        currentUserStatus
    };
}

export interface ListGroupsFilter {
    category?: string;
    viewerPubkey?: string;
    memberPubkey?: string;
    search?: string;
    limit?: number;
    offset?: number;
}

export function listGroups(db: Db, filter?: ListGroupsFilter): Group[] {
    let query = `
        SELECT g.*,
               (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.status = 'active') as member_count,
               (SELECT COUNT(*) FROM posts p WHERE p.target_group_id = g.id AND p.type = 'need' AND p.active = 1 AND p.status = 'active') as open_needs_count
        FROM groups g
        WHERE 1=1
    `;
    const params: any[] = [];

    if (filter?.category && filter.category !== 'all') {
        query += ' AND g.category = ?';
        params.push(filter.category);
    }

    if (filter?.memberPubkey) {
        query += ` AND g.id IN (SELECT group_id FROM group_members WHERE member_pubkey = ? AND status = 'active')`;
        params.push(filter.memberPubkey);
    }

    if (filter?.search && filter.search.trim()) {
        query += ' AND (g.name LIKE ? OR g.description LIKE ? OR g.slug LIKE ?)';
        const term = `%${filter.search.trim()}%`;
        params.push(term, term, term);
    }

    query += ' ORDER BY g.is_official DESC, g.updated_at DESC';

    if (filter?.limit) {
        query += ' LIMIT ? OFFSET ?';
        params.push(filter.limit, filter.offset || 0);
    }

    const rows = db.prepare(query).all(...params) as any[];
    const viewer = filter?.viewerPubkey;

    const viewerMemberships = new Map<string, { role: GroupRole; status: GroupMemberStatus }>();
    if (viewer) {
        const memberships = db.prepare(`
            SELECT group_id, role, status FROM group_members WHERE member_pubkey = ?
        `).all(viewer) as any[];
        for (const m of memberships) {
            viewerMemberships.set(m.group_id, { role: m.role, status: m.status });
        }
    }

    return rows.map(row => {
        const mem = viewerMemberships.get(row.id);
        return {
            id: row.id,
            name: row.name,
            slug: row.slug,
            description: row.description || undefined,
            avatarUrl: row.avatar_url || null,
            category: row.category as GroupCategory,
            createdBy: row.created_by,
            joinPolicy: row.join_policy as JoinPolicy,
            isOfficial: Boolean(row.is_official),
            treasuryPubkey: row.treasury_pubkey || null,
            conversationId: row.conversation_id || null,
            createdAt: row.created_at,
            updatedAt: row.updated_at || row.created_at,
            memberCount: row.member_count || 0,
            openNeedsCount: row.open_needs_count || 0,
            currentUserRole: mem?.role || null,
            currentUserStatus: mem?.status || null
        };
    });
}

export function getGroupMembers(db: Db, groupId: string): GroupMember[] {
    const rows = db.prepare(`
        SELECT gm.*, m.callsign, m.avatar_url
        FROM group_members gm
        LEFT JOIN members m ON gm.member_pubkey = m.public_key
        WHERE gm.group_id = ?
        ORDER BY 
            CASE gm.role WHEN 'steward' THEN 1 WHEN 'member' THEN 2 WHEN 'observer' THEN 3 ELSE 4 END,
            gm.joined_at ASC
    `).all(groupId) as any[];

    return rows.map(r => ({
        groupId: r.group_id,
        memberPubkey: r.member_pubkey,
        callsign: r.callsign || undefined,
        avatarUrl: r.avatar_url || null,
        role: r.role as GroupRole,
        status: r.status as GroupMemberStatus,
        joinedAt: r.joined_at,
        invitedBy: r.invited_by || null,
        updatedAt: r.updated_at || r.joined_at
    }));
}

export function joinGroup(db: Db, groupId: string, memberPubkey: string, invitedBy?: string): GroupMember {
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId) as any;
    if (!group) {
        throw new Error('Group not found');
    }

    const existing = db.prepare(`
        SELECT * FROM group_members WHERE group_id = ? AND member_pubkey = ?
    `).get(groupId, memberPubkey) as any;

    if (existing) {
        if (existing.status === 'active') {
            throw new Error('You are already an active member of this group');
        }
        if (existing.status === 'pending_approval') {
            throw new Error('Your join request is already pending approval');
        }
    }

    const joinPolicy = group.join_policy as JoinPolicy;
    if (joinPolicy === 'invite_only' && !invitedBy) {
        throw new Error('This group is invite-only. A steward must invite you.');
    }

    const status: GroupMemberStatus = (joinPolicy === 'open' || invitedBy) ? 'active' : 'pending_approval';
    const role: GroupRole = 'member';
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, invited_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id, member_pubkey) DO UPDATE SET
            role = excluded.role,
            status = excluded.status,
            invited_by = COALESCE(excluded.invited_by, group_members.invited_by),
            updated_at = excluded.updated_at
    `).run(groupId, memberPubkey, role, status, now, invitedBy || null, now);

    return {
        groupId,
        memberPubkey,
        role,
        status,
        joinedAt: now,
        invitedBy: invitedBy || null,
        updatedAt: now
    };
}

export function setMemberRole(
    db: Db,
    groupId: string,
    targetMemberPubkey: string,
    role: GroupRole,
    status: GroupMemberStatus = 'active',
    actorPubkey?: string
): GroupMember {
    if (!isValidGroupRole(role)) {
        throw new Error(`Invalid group role: ${role}`);
    }

    if (actorPubkey && !isGroupSteward(db, groupId, actorPubkey)) {
        throw new Error('Only a group steward can change member roles');
    }

    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id, member_pubkey) DO UPDATE SET
            role = excluded.role,
            status = excluded.status,
            updated_at = excluded.updated_at
    `).run(groupId, targetMemberPubkey, role, status, now, now);

    return {
        groupId,
        memberPubkey: targetMemberPubkey,
        role,
        status,
        joinedAt: now,
        updatedAt: now
    };
}

export function removeGroupMember(db: Db, groupId: string, targetMemberPubkey: string, actorPubkey: string): boolean {
    const isSelf = targetMemberPubkey === actorPubkey;
    const isSteward = isGroupSteward(db, groupId, actorPubkey);

    if (!isSelf && !isSteward) {
        throw new Error('You do not have permission to remove this member');
    }

    // If removing a steward, ensure at least one active steward remains
    const targetMember = db.prepare(`
        SELECT role FROM group_members WHERE group_id = ? AND member_pubkey = ?
    `).get(groupId, targetMemberPubkey) as any;

    if (targetMember?.role === 'steward') {
        const stewardCount = db.prepare(`
            SELECT COUNT(*) as c FROM group_members
            WHERE group_id = ? AND role = 'steward' AND status = 'active'
        `).get(groupId) as any;

        if (stewardCount.c <= 1) {
            throw new Error('Cannot remove the only steward. Appoint another steward first.');
        }
    }

    const res = db.prepare(`
        DELETE FROM group_members WHERE group_id = ? AND member_pubkey = ?
    `).run(groupId, targetMemberPubkey);

    return res.changes > 0;
}

export function isGroupSteward(db: Db, groupId: string, memberPubkey: string): boolean {
    const row = db.prepare(`
        SELECT 1 FROM group_members
        WHERE group_id = ? AND member_pubkey = ? AND role = 'steward' AND status = 'active'
    `).get(groupId, memberPubkey);
    return !!row;
}

export function isGroupMember(db: Db, groupId: string, memberPubkey: string): boolean {
    const row = db.prepare(`
        SELECT 1 FROM group_members
        WHERE group_id = ? AND member_pubkey = ? AND status = 'active'
    `).get(groupId, memberPubkey);
    return !!row;
}

export function getMemberGroupIds(db: Db, memberPubkey: string): string[] {
    const rows = db.prepare(`
        SELECT group_id FROM group_members
        WHERE member_pubkey = ? AND status = 'active'
    `).all(memberPubkey) as { group_id: string }[];
    return rows.map(r => r.group_id);
}
