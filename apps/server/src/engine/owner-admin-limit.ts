/**
 * Owners' and admins' own content limits (Marty, 31 Oct, with Damo, an owner on global refused a 6th upcoming gig: "make
 * it the same as the posts limits setting"). For a member whose node role is owner or admin NOW (nodeRoleOf: an active,
 * joined row, read at every check, so taking the role away restores a member's limits at once), every content-creation
 * limit a member has is the owners' "Owner and admin limit" (agent/limits.ts agentPostsPerDay: 100 unless an owner sets 1
 * to 1,000, with a fresh proof), in place of the member's number:
 *   - new posts in any 24 hours (WRITER_LIMITS.postsPerDay, 100), and a keeper's own once an enterprise's day is spent;
 *   - groups started in any 24 hours (groupsPerDay, 5);
 *   - enterprises started in any 24 hours (enterprisesPerDay, 3), and still running (enterprisesLive, 20);
 *   - upcoming events in a pool (engine/posts.ts EVENT_UPCOMING_CAP, 5), by the role of the member acting: a keeper's for
 *     an enterprise's events, the host's for a group's;
 *   - their own active polls (1). The node-wide 5 active polls stays as it is, for everyone;
 *   - invites made in any 24 hours (invitesPerDay, 20; an offline ticket by its maker's role, when someone joins with it)
 *     and invites unused at once (invitesUnused, 50) (Marty, 31 Oct ~20:35);
 *   - links added to the Pulse by hand in any 24 hours (pulseSubmissionsPerDay, 50) (the same).
 * A per-day limit is the setting per 24 hours; a count at once is the setting as the count. It IS the setting, never the
 * bigger of the two: owners who set it below a member's number hold owners and admins to that too. Moderators, and
 * members, keep the member's numbers. What an owner's assistant makes keeps its own count against the same setting
 * (agent/owner-posts.ts), apart from the owner's own posts. The enterprise's own numbers (its 1,000 posts a day, a
 * keeper's 1,000 for the enterprises they keep), money and messages are not content limits here, nor are Pulse items a
 * sync or the harvester adds: nobody submits those (300 and 400 a day, for everyone).
 */
import { agentPostsPerDay } from '../agent/limits.js';
import { nodeRoleOf } from './node-roles.js';

/** What a refusal calls the setting, where an owner changes it (the manager's Connected assistants, which the phone's Manage opens). */
export const OWNER_ADMIN_LIMIT_NAME = 'Owner and admin limit';

/** The owners' "Owner and admin limit" when `actor` is an owner or admin now, else null (a member's own numbers apply). */
export function ownerAdminLimit(actor: string | null | undefined): number | null {
    if (!actor) return null;
    const role = nodeRoleOf(actor);
    return role === 'owner' || role === 'admin' ? agentPostsPerDay() : null;
}
