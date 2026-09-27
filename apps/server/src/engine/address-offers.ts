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
 * Who signed can't make a host safe to confirm with one tap. Members' keys can all be one person's: any member can make
 * invites for herself and redeem them with fresh keys, in seconds (4114742184). And another community's operator can
 * relay here the requests members of both communities, or our owner (a knock is enough), signed for its own host. So:
 *
 * ONE TAP only for the page's own host: the host the owner's or admin's browser reaches the node at for Settings right
 * now (`?host=`, sent by Settings). It must be a host a member's app can sign for here and that isn't this community's
 * yet (audienceStanding `unconfigured`: well formed, not this machine or its network, on a node with none of its names),
 * with or without a count; it is offered the same after the switch, when apps are refused there until it is confirmed.
 * A one-person node confirms its real name that way, from the page it is using.
 *
 * Every other host is HELD BACK, with its counts (members' apps today and on the busiest day, and whether an owner's or
 * admin's app reached the node there), and a reason, checked in this order:
 *   - `another-community`: a name in the registrar's zone (isBeanPoolName). This node's own registrar name is one of its
 *     configured names (item 1 or 4) and never on this list, so any other beanpool.org name is another community's, or
 *     free for one to claim. Never offered, the page's own host included: Settings shows no confirm for it;
 *   - `directory`: the public directory this node holds lists it as a community's address, with the name it gives.
 *     Settings warns, names that community, and confirms it only once the owner ticks that it is this community. Only a
 *     node that holds the directory can say so: directory_cache (engine/directory-cache.ts) is written only by the
 *     directory mirror, which runs where the `directoryMirror` switch is on (the global profile's default; off by
 *     default in the local one), and is copied by a standby of such a node. No fetch is made for this. Elsewhere this reason never appears,
 *     and such a host is `not-this-page` like any other. Anyone can list any address, so a match proves only that
 *     someone listed it: it is a reason to warn, never to refuse the owner;
 *   - `not-this-page`: any other host. Settings shows it with its counts and confirms it only once the owner ticks
 *     that it is this community's address.
 *
 * Only what Settings OFFERS changes here. What a node accepts until the switch, the counts and their bounds, the
 * confirm route (an owner or admin may still send it any address: a renamed node keeps its old name that way, item 3),
 * and what a confirmed address does, are unchanged.
 */

import { listedCommunityAt } from './directory-cache.js';
import { audienceStanding, isBeanPoolName, normalizeAddress } from './own-addresses.js';

export type HeldBackReason = 'another-community' | 'directory' | 'not-this-page';

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

/**
 * The host Settings is open at (`?host=`), in the form apps sign it, when it can be offered with one tap: one a
 * member's app can sign for here that isn't this community's yet, and not a beanpool.org name. Null otherwise.
 */
export function offerablePageHost(pageHost: unknown): string | null {
    const page = normalizeAddress(pageHost);
    return page && audienceStanding(page) === 'unconfigured' && !isBeanPoolName(page) ? page : null;
}

/**
 * Whether Settings offers `address` to confirm with one tap, or holds it back and why (the rule above). `page` is
 * offerablePageHost's answer for the host Settings is open at, or null.
 */
export function offerStanding(address: string, page: string | null): AddressOfferStanding {
    const listed = listedCommunityAt(address);
    const directory = listed ? { name: listed.name } : null;
    if (isBeanPoolName(address)) return { offer: false, reason: 'another-community', directory };
    if (directory) return { offer: false, reason: 'directory', directory };
    if (address !== page) return { offer: false, reason: 'not-this-page', directory: null };
    return { offer: true };
}
