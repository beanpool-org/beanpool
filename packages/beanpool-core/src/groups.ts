/**
 * Groups, Teams, Roles & Audience Scoping
 *
 * Core domain types and utilities for BeanPool's collective organization primitive.
 * Decision of record: docs/the-commons.md §9.
 *
 * HARD RULES from §9:
 * - A group is an audience scope and NOTHING else.
 * - It holds no money, grants no trust, confers no node role, and is never linked to an enterprise.
 * - Roles: convenor | member | observer (NOT "steward" and NOT "host").
 * - Join policies: open | request_to_join | invite_only.
 * - Audience scopes: public | group | direct.
 */

export type GroupRole = 'convenor' | 'member' | 'observer';

export const GROUP_ROLES: readonly GroupRole[] = ['convenor', 'member', 'observer'] as const;

export type JoinPolicy = 'open' | 'request_to_join' | 'invite_only';

export const JOIN_POLICIES: readonly JoinPolicy[] = ['open', 'request_to_join', 'invite_only'] as const;

export type GroupCategory = 'working_group' | 'social' | 'guild' | 'project' | 'general';

export const GROUP_CATEGORIES: readonly GroupCategory[] = [
    'working_group',
    'social',
    'guild',
    'project',
    'general'
] as const;

export type AudienceScope = 'public' | 'group' | 'direct';

export const AUDIENCE_SCOPES: readonly AudienceScope[] = ['public', 'group', 'direct'] as const;

/**
 * 'removed' is a convenor's removal, kept as a record so it sticks: the person cannot Join (or ask to join)
 * again until a convenor re-admits them by invitation or approval. Leaving on your own deletes the row instead,
 * so a member who left can come back to an open group. Only 'active' is ever a member.
 */
export type GroupMemberStatus = 'active' | 'pending_approval' | 'invited' | 'removed';

export const GROUP_MEMBER_STATUSES: readonly GroupMemberStatus[] = [
    'active',
    'pending_approval',
    'invited',
    'removed'
] as const;

export interface Group {
    id: string;
    name: string;
    slug: string;
    description?: string;
    avatarUrl?: string | null;
    category: GroupCategory;
    createdBy: string;
    joinPolicy: JoinPolicy;
    createdAt: string;
    updatedAt?: string;
    memberCount?: number;
    currentUserRole?: GroupRole | null;
    currentUserStatus?: GroupMemberStatus | null;
    viewerRole?: GroupRole | null;
    viewerStatus?: GroupMemberStatus | null;
    convenorPubkey?: string;
    convenorCallsign?: string;
    convenorAvatarUrl?: string | null;
}

export interface GroupMember {
    groupId: string;
    memberPubkey: string;
    callsign?: string;
    avatarUrl?: string | null;
    role: GroupRole;
    status: GroupMemberStatus;
    joinedAt: string;
    invitedBy?: string | null;
    updatedAt?: string;
}

export function isValidGroupRole(val: unknown): val is GroupRole {
    return typeof val === 'string' && (GROUP_ROLES as readonly string[]).includes(val as GroupRole);
}

export function isValidJoinPolicy(val: unknown): val is JoinPolicy {
    return typeof val === 'string' && (JOIN_POLICIES as readonly string[]).includes(val as JoinPolicy);
}

export function isValidAudienceScope(val: unknown): val is AudienceScope {
    return typeof val === 'string' && (AUDIENCE_SCOPES as readonly string[]).includes(val as AudienceScope);
}

export function isValidGroupCategory(val: unknown): val is GroupCategory {
    return typeof val === 'string' && (GROUP_CATEGORIES as readonly string[]).includes(val as GroupCategory);
}

export function isValidGroupMemberStatus(val: unknown): val is GroupMemberStatus {
    return typeof val === 'string' && (GROUP_MEMBER_STATUSES as readonly string[]).includes(val as GroupMemberStatus);
}

export const isGroupRole = isValidGroupRole;
export const isJoinPolicy = isValidJoinPolicy;
export const isAudienceScope = isValidAudienceScope;
export const isGroupCategory = isValidGroupCategory;
export const isGroupMemberStatus = isValidGroupMemberStatus;
