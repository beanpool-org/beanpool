/**
 * The message a member's Share sends with one of their invites (front doors S10, DESIGN-entry-points-fable.md §3.2 item 3),
 * one sentence for both apps (People > Invites on the phone and on the web), in the member's language.
 *
 * Plain words for a friend who has never heard of BeanPool: no "node", no "URL". The link first; then what to do if the link
 * doesn't open (install the app and paste the code); then the community's address, for a phone whose app asks for it.
 */
import { t } from './words.js';

/**
 * `name` is the community's name, or its address where it has none; `address` the community's address (host, no scheme).
 * `billFrom`: the inviter's name when the invite carries a bill (DESIGN-getting-paid-fable.md §4.5, slice B3): the message
 * then says plainly, right after the link, that a bill comes with it. Never its amount.
 */
export function inviteShareText(p: { name: string; link: string; code: string; address: string; billFrom?: string | null }): string {
    const billFrom = p.billFrom?.trim();
    if (billFrom) {
        return t(
            "Join my BeanPool community, {name}:\n{link}\n\n{inviter} has also sent you a bill to pay in Beans once you're in.\n\nIf the link doesn't open, install BeanPool from beanpool.org and paste this code:\n{code}\n\nCommunity address: {address}",
            { name: p.name, link: p.link, code: p.code, address: p.address, inviter: billFrom },
        );
    }
    return t(
        "Join my BeanPool community, {name}:\n{link}\n\nIf the link doesn't open, install BeanPool from beanpool.org and paste this code:\n{code}\n\nCommunity address: {address}",
        { name: p.name, link: p.link, code: p.code, address: p.address },
    );
}

/** A community's address as a friend reads it: the host (and port), with no scheme and no trailing slash. */
export function shareAddress(origin: string): string {
    return origin.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}
