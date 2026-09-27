/**
 * Which hosts Settings offers an owner to confirm as this community's address (routes/app-addresses.ts), on a node that
 * knows none of its names (engine/own-addresses.ts `unconfigured`).
 *
 * Such a node accepts a member's request signed for any host until the switch, and counts the members' apps that
 * signed for each (engine/member-signature.ts `unconfirmed`). A host an owner confirms is this community's name for good
 * (own-addresses.ts item 3): from then on a request signed for it is accepted here. One member has the same key at every
 * community, so confirming another community's name makes the requests members sign for THAT community valid here, and
 * anyone who sees them (its operator) can replay them. Before this, one member's app signing for a host was enough to
 * have it offered with one tap, mullum.beanpool.org included (#1219's deciding pass; the director's queue, 2026-09-27).
 *
 * A host is OFFERED (one tap, as before) only when all of these hold:
 *   - it is not a name in the registrar's zone (isBeanPoolName). This node's own registrar name is one of its
 *     configured names (item 1 or 4) and never on this list, so any other beanpool.org name is another community's, or
 *     free for one to claim. Held back, reason `another-community`, whoever's app signed for it: a hostile community's
 *     operator can relay our owner's own request, signed for that community, here;
 *   - an owner's or admin's own app signed for it this week, or at least MEMBERS_TO_OFFER members' apps did on one day.
 *     Otherwise held back, reason `few-members`. A one-person community (its only member is the owner) is offered its
 *     real name as soon as the owner's app reaches it there;
 *   - the public directory this node already holds (directory_cache, engine/directory-cache.ts: the global node's
 *     mirror, or a standby's copy of it; no fetch for this) does not list it as a community's address. Otherwise held
 *     back, reason `directory`, with the name the directory gives. Anyone can list any address there, so the directory
 *     can't prove a host is someone else's: Settings warns, names that community, and lets the owner confirm on
 *     purpose, where the two reasons above offer no confirm at all.
 * The reasons are checked in that order, so a host both listed and reached by one member's app is `few-members`, with
 * the directory's name as well.
 *
 * MEMBERS_TO_OFFER is 3: more than one person and a second key of their own (an invite they gave themselves), and small
 * enough that a real address is offered on its first day in a community of a handful of people. The owner's own app
 * makes it one tap anyway. It only decides what is offered: the rule above for another community's name doesn't count.
 *
 * Only what Settings OFFERS changes here. What a node accepts until the switch, the confirm route (an owner or admin
 * may still send it any address), and what a confirmed address does, are unchanged.
 */

import { listedCommunityAt } from './directory-cache.js';
import { isBeanPoolName } from './own-addresses.js';

/** How many members' apps, on one day, get a host offered when no owner's or admin's app reached the node there. */
export const MEMBERS_TO_OFFER = 3;

export type HeldBackReason = 'another-community' | 'few-members' | 'directory';

export interface AddressSighting {
    address: string;
    /** Members' apps that signed for it today (UTC). */
    today: number;
    /** Members' apps that signed for it on the busiest day of the last 7. */
    busiestDay: number;
    /** Whether an owner's or admin's app signed for it in the last 7 days. */
    ownerOrAdmin: boolean;
}

export type AddressOfferStanding =
    | { offer: true }
    | { offer: false; reason: HeldBackReason; directory: { name: string | null } | null };

/** Whether Settings offers `s.address` to confirm with one tap, or holds it back and why (the rule above). */
export function offerStanding(s: AddressSighting): AddressOfferStanding {
    const listed = listedCommunityAt(s.address);
    const directory = listed ? { name: listed.name } : null;
    if (isBeanPoolName(s.address)) return { offer: false, reason: 'another-community', directory };
    if (!s.ownerOrAdmin && s.busiestDay < MEMBERS_TO_OFFER) return { offer: false, reason: 'few-members', directory };
    if (directory) return { offer: false, reason: 'directory', directory };
    return { offer: true };
}
