/**
 * Groups, Teams, Roles & Audience Scoping
 *
 * Core domain types and utilities for BeanPool's collective organization primitive.
 */

export type GroupRole = 'steward' | 'member' | 'observer';

export const GROUP_ROLES: readonly GroupRole[] = ['steward', 'member', 'observer'] as const;

export type JoinPolicy = 'open' | 'request_to_join' | 'invite_only';

export const JOIN_POLICIES: readonly JoinPolicy[] = ['open', 'request_to_join', 'invite_only'] as const;

export type GroupCategory = 'enterprise' | 'project' | 'guild' | 'working_group' | 'social' | 'general';

export const GROUP_CATEGORIES: readonly GroupCategory[] = [
    'enterprise',
    'project',
    'guild',
    'working_group',
    'social',
    'general'
] as const;

export type AudienceScope = 'public' | 'group' | 'direct';

export const AUDIENCE_SCOPES: readonly AudienceScope[] = ['public', 'group', 'direct'] as const;

export type GroupMemberStatus = 'active' | 'pending_approval' | 'invited';

export const GROUP_MEMBER_STATUSES: readonly GroupMemberStatus[] = [
    'active',
    'pending_approval',
    'invited'
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
    isOfficial: boolean;
    treasuryPubkey?: string | null;
    conversationId?: string | null;
    createdAt: string;
    updatedAt?: string;
    memberCount?: number;
    openNeedsCount?: number;
    currentUserRole?: GroupRole | null;
    currentUserStatus?: GroupMemberStatus | null;
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

/** Check if a role has steward/administrative authority in a group */
export function canManageGroup(role?: GroupRole | null): boolean {
    return role === 'steward';
}

/** Check if a role can participate (post/claim needs, chat) */
export function canPostToGroup(role?: GroupRole | null): boolean {
    return role === 'steward' || role === 'member';
}
