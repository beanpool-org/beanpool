/**
 * Whether members make invites on this node (`features.invites` in `/api/community/info`, config/node-profile.ts on the
 * server). Off on the global node (Marty, 2026-10-01): anyone joins it with a sign-in, one sign-in one member, and the
 * server refuses every invite there. Only a node that says outright it makes none makes none: every node before the
 * switch took them. Where they are off the Invites page offers the community's plain link to share, and nothing else.
 */

import type { CommunityInfo } from './api';

export function invitesOn(info: CommunityInfo | null | undefined): boolean {
    return (info?.features as { invites?: boolean } | undefined)?.invites !== false;
}

/** What the share sends: the community's plain address, which opens its front door. No code rides along. */
export function communityLinkText(origin: string): string {
    return `Join me on BeanPool: ${origin.trim().replace(/\/+$/, '')}`;
}

/** Said where the node's own words are missing. */
export const INVITES_OFF_FALLBACK = 'This community doesn’t use invites: anyone joins it with a sign-in in the BeanPool app. To bring someone here, share its link.';

/**
 * The node's words when it refused a generate because it takes no invites (404 `feature_off`, as `request` throws it in
 * lib/api.ts), or null for any other failure. Read so the page says so instead of making an offline ticket, which the
 * node would refuse just the same.
 */
export function invitesOffRefusal(e: unknown): string | null {
    const err = e as { status?: unknown; code?: unknown; message?: unknown } | null | undefined;
    if (!err || typeof err !== 'object' || err.status !== 404 || err.code !== 'feature_off') return null;
    return typeof err.message === 'string' && err.message.trim() ? err.message : INVITES_OFF_FALLBACK;
}

// ── Who may invite (the door) ────────────────────────────────────────────────────────────────────────────────────────
// A community may choose that only its owners and admins invite (`features.door === 'admins'`, config/door.ts on the
// server; Settings calls it "Known"). A member who is neither makes none there: no code, QR or offline ticket. Any other
// door, or a node that says nothing (older than the door), is as before: any member invites. A role, never a tier.

type Features = { door?: unknown; knocks?: unknown } | undefined;

export function onlyAdminsInvite(info: CommunityInfo | null | undefined): boolean {
    return (info?.features as Features)?.door === 'admins';
}

/** Whether this community takes requests to join (`features.knocks`; never on the global node). Unknown counts as yes. */
export function takesKnocks(info: CommunityInfo | null | undefined): boolean {
    return info?.profile !== 'global' && (info?.features as Features)?.knocks !== false;
}

/** A member's node role as the node said it (GET /api/node-admin/me): null for none. */
export type InviteRole = 'owner' | 'admin' | 'moderator' | null;

export function readInviteRole(role: unknown): InviteRole {
    return role === 'owner' || role === 'admin' || role === 'moderator' ? role : null;
}

/**
 * Whether this member makes invites here. `role` undefined: the node hasn't said (not asked yet, or no answer), which
 * counts as before: the node decides when they try, and says why if not (adminsOnlyRefusal).
 */
export function mayInviteHere(info: CommunityInfo | null | undefined, role: InviteRole | undefined): boolean {
    if (!invitesOn(info)) return false;
    if (!onlyAdminsInvite(info) || role === undefined) return true;
    return role === 'owner' || role === 'admin';
}

/**
 * Whether the page may fall back to an offline ticket (the node unreachable). Where only admins invite, only for a member
 * the node has said is an owner or admin: a member's ticket is refused at the join, and a role not heard is no answer.
 */
export function mayMakeOfflineTicket(info: CommunityInfo | null | undefined, role: InviteRole | undefined): boolean {
    if (!invitesOn(info)) return false;
    return !onlyAdminsInvite(info) || role === 'owner' || role === 'admin';
}

/** Said where the node's own words are missing. */
export const ADMINS_ONLY_FALLBACK = 'In this community only its admins invite people. Ask an admin to bring them in.';

/** Why no offline ticket was made where only admins invite and the node couldn't be reached to ask who this member is. */
export const OFFLINE_ADMINS_ONLY_TEXT = 'You’re offline, and in this community only its admins invite people. Try again when you’re back online.';

/** What a member who may not invite sees in place of "Invite Someone". `knocks`: the community takes requests to join. */
export function adminsOnlyText(knocks: boolean): string {
    return knocks
        ? 'In this community only its admins invite people. Share its link: in the BeanPool app they can ask to join, and an admin will answer. Or ask an admin to invite them.'
        : 'In this community only its admins invite people. Ask an admin to invite them.';
}

/**
 * The node's words when it refused a generate because only admins invite here (403 `admins_only`, as `request` throws
 * it), or null for any other failure. Read so the page says so and makes no offline ticket, which the node would refuse.
 */
export function adminsOnlyRefusal(e: unknown): string | null {
    const err = e as { status?: unknown; code?: unknown; message?: unknown } | null | undefined;
    if (!err || typeof err !== 'object' || err.status !== 403 || err.code !== 'admins_only') return null;
    return typeof err.message === 'string' && err.message.trim() ? err.message : ADMINS_ONLY_FALLBACK;
}
