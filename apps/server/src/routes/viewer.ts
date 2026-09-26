/**
 * Who is reading (global node G9a, "the listings, not the people"): a member of this node, or a guest.
 *
 * A guest is any reader the node cannot tie to a member: an unsigned request, or one signed by a key that is not a
 * member here. Both apps' guest visits sign (the web app with a local key the node has never met, the phone's
 * deliberate guest visit through its signing wrapper), so a valid signature alone never makes a member. A pruned
 * account, and the old key of a member being re-keyed, keep their row and can still sign, and are guests too. So are a
 * suspended or disabled member while that lasts, and a visitor's row: they see what a non-member sees (Marty,
 * 2026-09-26).
 *
 * The test is readsAsMember, the one every member-only read applies (poll voters, contact details, the People list's
 * distances, the activity feed, the /ws member feed), so they cannot drift apart. It reads the verified signer only
 * (ctx.state.actor, set by the signature middleware), never a key from the request.
 *
 * On a node whose `guestListingsOnly` switch is on (the global profile), a guest gets the listings and their rough
 * area and nobody in them (the engine's guestPost); elsewhere the tier changes nothing but what it always did.
 */
import type { Context } from 'koa';
import { isNodeMember, readsAsMember } from '../state-engine.js';
import { getProfileSwitches } from '../config/node-profile.js';

export type ViewerTier = 'member' | 'guest';

export function viewerTier(ctx: Pick<Context, 'state'>): ViewerTier {
    return readsAsMember(ctx.state.actor as string | undefined) ? 'member' : 'guest';
}

/** Whether this reader gets the visitors' view: a guest, on a node that shows guests the listings and not the people. */
export function seesGuestView(ctx: Pick<Context, 'state'>): boolean {
    return viewerTier(ctx) === 'guest' && getProfileSwitches().guestListingsOnly;
}

/** Says which view a response is, on a node that has two (`X-BeanPool-View`; the phone keeps only the one it expects,
 *  apps/native utils/posts-view.ts). Elsewhere nothing is said, as before G9a. */
export const VIEW_HEADER = 'X-BeanPool-View';

function refuseMembersOnly(ctx: Context): false {
    ctx.status = 403;
    ctx.body = { error: 'This is for members of this community', code: 'members_only' };
    return false;
}

/**
 * For a route where the caller ACTS and the answer hands back other members (the trade with its other party, the
 * message and who reacted to it, the group they act in), on a node that shows guests the listings and not the people:
 * only a member of this node goes on (isNodeMember, the act test). Anyone else is answered 403 `members_only` and the
 * route stops (false). A suspended or disabled member and a visitor's row go on, as they always have: what they may do
 * is suspension's rule and each route's, not this one's, and the people in the answer are the ones they are acting with.
 *
 * A route's own test of its caller does not stand in for this one: a pruned account keeps its member row, its group
 * roles, its friends and its conversations, and can still sign, and a POST is seen by neither the read gate nor the
 * public-read sweep. For a member, and on every other node, this changes nothing.
 */
export function membersOnlyHere(ctx: Context): boolean {
    if (isNodeMember(ctx.state.actor as string | undefined) || !getProfileSwitches().guestListingsOnly) return true;
    return refuseMembersOnly(ctx);
}

/**
 * membersOnlyHere for a route that only READS other members (a member's standing and who brought them in), on the same
 * nodes: only a reader who reads as a member (viewerTier, readsAsMember) gets an answer. A suspended or disabled member
 * and a visitor are refused too, as a guest is.
 */
export function memberReadsOnlyHere(ctx: Context): boolean {
    if (viewerTier(ctx) === 'member' || !getProfileSwitches().guestListingsOnly) return true;
    return refuseMembersOnly(ctx);
}
