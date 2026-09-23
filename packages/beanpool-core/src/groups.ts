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

/**
 * In the order every create form lists them (groups decision 11, 2026-09-19): Social Circle first and
 * pre-selected, then General, Working Group, Project Team, Guild. The stored keys stay as they are — 'project'
 * is shown as "Project Team" — so no group row has to change.
 */
export const GROUP_CATEGORIES: readonly GroupCategory[] = [
    'social',
    'general',
    'working_group',
    'project',
    'guild'
] as const;

export const DEFAULT_GROUP_CATEGORY: GroupCategory = 'social';

export const GROUP_CATEGORY_LABELS: Readonly<Record<GroupCategory, string>> = {
    social: 'Social Circle',
    general: 'General',
    working_group: 'Working Group',
    project: 'Project Team',
    guild: 'Guild',
};

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
    /** The viewer's own open invitation: who sent it (invite landing, groups slice 2). */
    viewerInvitedBy?: { pubkey: string; callsign?: string; avatarUrl?: string };
    viewerStatus?: GroupMemberStatus | null;
    convenorPubkey?: string;
    convenorCallsign?: string;
    convenorAvatarUrl?: string | null;
    /**
     * The group's LEAD convenor (2026-09-23). One per group, stored as `groups.lead_pubkey`. The creator to
     * begin with; it moves only by hand-over, by the lead stepping down or leaving, by the 30-day-silence vote,
     * or by a community Decision. Null only for a group with no active convenor at all.
     */
    leadPubkey?: string | null;
    leadCallsign?: string;
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

// ===================== THE LEAD CONVENOR (2026-09-23) =====================
//
// A group has ONE lead convenor and any number of ordinary convenors. Never "owner": in BeanPool an owner owns a
// community node (docs/the-commons.md §2.3 vocabulary line). The powers, as the engine enforces them
// (packages/beanpool-engine/src/groups.ts):
//
//  - Any convenor: approve, invite and remove members and observers; promote someone to convenor; remove posts
//    and messages; edit the group and its join policy.
//  - Only the lead: remove or demote another convenor.
//  - Nobody: remove or demote the lead. Node admins included — they hold no power over groups, and this change
//    does not give them one.
//
// These predicates are what the rosters ask before drawing Role and ✕ on a row, so a convenor never sees an
// action the server would refuse. They say the SAME thing the engine says; the engine is still what enforces it.

/** The viewer, as the roster knows them. */
export interface GroupRowViewer {
    role?: GroupRole | null;
    status?: GroupMemberStatus | null;
    /** Is the viewer this group's lead convenor? */
    isLead: boolean;
}

/** One roster row. */
export interface GroupRowTarget {
    memberPubkey: string;
    role: GroupRole;
    status?: GroupMemberStatus | null;
    /** Is this row the group's lead convenor? */
    isLead: boolean;
}

export interface GroupRowActions {
    /** Show the Role control on this row. */
    canChangeRole: boolean;
    /** Show the ✕ (remove, decline, withdraw) on this row. */
    canRemove: boolean;
    /** Show "Hand over lead" on this row. */
    canHandOverLead: boolean;
}

const NO_GROUP_ROW_ACTIONS: GroupRowActions = { canChangeRole: false, canRemove: false, canHandOverLead: false };

/** An active convenor — the only viewer who moderates anything. */
export function isActiveGroupConvenor(viewer: GroupRowViewer): boolean {
    return viewer.role === 'convenor' && (viewer.status == null || viewer.status === 'active');
}

/**
 * What the viewer may do to one roster row. Their own row: nothing — leaving is the Leave Group button, and a
 * lead hands the lead over rather than demoting themselves.
 */
export function groupRowActions(viewer: GroupRowViewer, target: GroupRowTarget, viewerPubkey?: string): GroupRowActions {
    if (!isActiveGroupConvenor(viewer)) return NO_GROUP_ROW_ACTIONS;
    if (viewerPubkey && target.memberPubkey === viewerPubkey) return NO_GROUP_ROW_ACTIONS;
    // Nobody removes or demotes the lead — not another convenor, not a node admin.
    if (target.isLead) return NO_GROUP_ROW_ACTIONS;
    const targetIsActiveConvenor = target.role === 'convenor' && (target.status == null || target.status === 'active');
    // Only the lead may touch another convenor.
    if (targetIsActiveConvenor && !viewer.isLead) return NO_GROUP_ROW_ACTIONS;
    return {
        canChangeRole: true,
        canRemove: true,
        // Hand over: to another active convenor, or to an active member who becomes a convenor in the same step.
        // An observer only watches — promote them first.
        canHandOverLead: viewer.isLead && target.role !== 'observer' && (target.status == null || target.status === 'active'),
    };
}

/** "Lead convenor" / "Convenor" / "Member" / "Observer", as the roster badge prints it. */
export function groupRoleLabel(role: GroupRole, isLead: boolean): string {
    if (isLead) return 'Lead convenor';
    return role === 'convenor' ? 'Convenor' : role === 'member' ? 'Member' : 'Observer';
}

/** A lead who tries to leave is asked to hand over first — but only while somebody else is still active. */
export function leadMustHandOverBeforeLeaving(isLead: boolean, otherActiveMembers: number): boolean {
    return isLead && otherActiveMembers > 0;
}

/**
 * The one hand-over the rules leave without a route: a lead whose only other active people are observers. Leaving
 * asks them to hand the lead over (anyone active counts), but an observer cannot take it, so the candidate list is
 * empty and both screens used to say "there is nobody" — true, and no help. What unblocks them is promoting an
 * observer, so the screens say that instead. The server's own hint for the same case is in handOverGroupLead.
 */
export function leadHandOverBlockedByObservers(handOverCandidates: number, activeObservers: number): boolean {
    return handOverCandidates === 0 && activeObservers > 0;
}

/** Short enough for an Alert body and for the PWA's error line at 320dp with 1.3x text. */
export const MAKE_OBSERVER_MEMBER_FIRST =
    'Make one of the observers a member first, then hand the lead to them.';
