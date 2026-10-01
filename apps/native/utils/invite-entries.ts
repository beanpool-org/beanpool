/**
 * People → Invites on a node that takes no invites (`features.invites === false`: the worldwide community,
 * apps/server config/node-profile.ts). Anyone joins it with a sign-in, so there is nothing to make: no code, no QR, no
 * offline ticket. What's left is the community's own link to share, a plain address and no more (design §1: "a link
 * is just marketing"). Every local community, and a node too old to say, as before (node-profile.ts invitesOn).
 *
 * And on a community where only its admins invite (the door, `features.door === 'admins'`): a member who is no owner or
 * admin there makes none either, and is told so in plain words. Their role is the node's answer, never a tier.
 */

import { invitesOn, type NodeFeatures } from './node-profile';

/** What the share sheet sends: the community's plain address, which opens its front door. */
export function communityLinkMessage(nodeUrl: string): string {
    return `Join me on BeanPool: ${nodeUrl.trim().replace(/\/+$/, '')}`;
}

/** Said where the node's own words are missing. */
export const INVITES_OFF_FALLBACK = 'This community doesn’t use invites: anyone joins it with a sign-in in the BeanPool app. To bring someone here, share its link.';

/**
 * The node's answer to a generate when it takes no invites (404 `feature_off`), in its own words, or null for any
 * other answer. A phone that hadn't heard the switch yet (an old copy of the node's profile) asks anyway; this stops
 * the screen falling back to an offline ticket, which the node would refuse just the same.
 */
export function invitesOffRefusal(status: number, body: unknown): string | null {
    const b = body as { code?: unknown; error?: unknown } | null | undefined;
    if (status !== 404 || !b || typeof b !== 'object' || b.code !== 'feature_off') return null;
    return typeof b.error === 'string' && b.error.trim() ? b.error : INVITES_OFF_FALLBACK;
}

/**
 * Said to a guest (a phone with an account elsewhere that added this community) on a node that takes no invites: there
 * is no code to enter here. Joining it from an account you already have isn't in the app yet (guide: Joining a
 * community), so no promise of a way in.
 */
export const GUEST_NO_INVITES_TEXT = 'This community doesn’t use invite codes. Joining it from an account you already have isn’t possible in the app yet.';

// ── Who may invite (the door) ────────────────────────────────────────────────────────────────────

/**
 * Where a community has chosen that only its owners and admins invite (`features.door === 'admins'`, apps/server
 * config/door.ts; Settings calls it "Known"), a member who is neither makes no invite there: no code, QR or offline
 * ticket. Any other door, or a node that says nothing (older than the door), is as before: any member invites.
 */
export function onlyAdminsInvite(features: NodeFeatures | null | undefined): boolean {
    return features?.door === 'admins';
}

/** A member's node role as the node said it (GET /api/node-admin/me): null for none. */
export type InviteRole = 'owner' | 'admin' | 'moderator' | null;

/**
 * Whether this member may make invites here. `role` undefined: the node hasn't said (not asked yet, or no answer and
 * none remembered), which counts as before: the node decides when they try, and says why if not.
 */
export function mayInviteHere(features: NodeFeatures | null | undefined, role: InviteRole | undefined): boolean {
    if (!invitesOn(features)) return false;
    if (!onlyAdminsInvite(features) || role === undefined) return true;
    return role === 'owner' || role === 'admin';
}

/** Said where the node's own words are missing. */
export const ADMINS_ONLY_FALLBACK = 'In this community only its admins invite people. Ask an admin to bring them in.';

/** What a member who may not invite sees in place of "Invite Someone". `knocks`: the community takes requests to join. */
export function adminsOnlyText(knocks: boolean): string {
    return knocks
        ? 'In this community only its admins invite people. Share its link: in the BeanPool app they can ask to join, and an admin will answer. Or ask an admin to invite them.'
        : 'In this community only its admins invite people. Ask an admin to invite them.';
}

/**
 * The node's answer to a generate from a member where only admins invite (403 `admins_only`), in its own words, or null
 * for any other answer. Read so the screen says so and makes no offline ticket, which the node would refuse at the join.
 */
export function adminsOnlyRefusal(status: number, body: unknown): string | null {
    const b = body as { code?: unknown; error?: unknown } | null | undefined;
    if (status !== 403 || !b || typeof b !== 'object' || b.code !== 'admins_only') return null;
    return typeof b.error === 'string' && b.error.trim() ? b.error : ADMINS_ONLY_FALLBACK;
}

/**
 * Whether the screen may fall back to an offline ticket (the node unreachable). Where only admins invite, only for a
 * member the node has said is an owner or admin: a member's ticket is refused at the join (apps/server config/door.ts),
 * and a role not heard (offline) is no answer, so nothing is made that may not join.
 */
export function mayMakeOfflineTicket(features: NodeFeatures | null | undefined, role: InviteRole | undefined): boolean {
    if (!invitesOn(features)) return false;
    return !onlyAdminsInvite(features) || role === 'owner' || role === 'admin';
}

/**
 * The join's pre-flight (GET /api/invite/check, reason `admins_only`): an offline ticket a member made, where only the
 * community's admins bring people in now. The node refuses it at the join too (apps/server config/door.ts).
 */
export const MEMBER_TICKET_REFUSED_TEXT = 'This invite was made by a member, and in this community only its admins bring people in now. Ask an admin for a fresh invite.';

/** Why no offline ticket was made where only admins invite and the node couldn't be reached to ask who this member is. */
export const OFFLINE_ADMINS_ONLY_TEXT = 'You’re offline, and in this community only its admins invite people. Try again when you’re back online.';
