/**
 * Who is reading (global node G9a, "the listings, not the people"): a member of this node, or a guest.
 *
 * A guest is any reader the node cannot tie to a member: an unsigned request, or one signed by a key that is not a
 * member here. Both apps' guest visits sign (the web app with a local key the node has never met, the phone's
 * deliberate guest visit through its signing wrapper), so a valid signature alone never makes a member. A pruned
 * account, and the old key of a member being re-keyed, keep their row and can still sign, and are guests too.
 *
 * The test is isNodeMember, the one every member-only read applies (poll voters, contact details, the People list's
 * distances, the /ws member feed), so they cannot drift apart. It reads the verified signer only (ctx.state.actor, set
 * by the signature middleware), never a key from the request.
 *
 * On a node whose `guestListingsOnly` switch is on (the global profile), a guest gets the listings and their rough
 * area and nobody in them (the engine's guestPost); elsewhere the tier changes nothing but what it always did.
 */
import type { Context } from 'koa';
import { isNodeMember } from '../state-engine.js';
import { getProfileSwitches } from '../config/node-profile.js';

export type ViewerTier = 'member' | 'guest';

export function viewerTier(ctx: Pick<Context, 'state'>): ViewerTier {
    return isNodeMember(ctx.state.actor as string | undefined) ? 'member' : 'guest';
}

/** Whether this reader gets the visitors' view: a guest, on a node that shows guests the listings and not the people. */
export function seesGuestView(ctx: Pick<Context, 'state'>): boolean {
    return viewerTier(ctx) === 'guest' && getProfileSwitches().guestListingsOnly;
}

/** Says which view a response is, on a node that has two (`X-BeanPool-View`; the phone keeps only the one it expects,
 *  apps/native utils/posts-view.ts). Elsewhere nothing is said, as before G9a. */
export const VIEW_HEADER = 'X-BeanPool-View';
