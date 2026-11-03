/**
 * The message a member's Share sends with one of their invites (front doors S10, DESIGN-entry-points-fable.md §3.2 item 3),
 * one sentence for both apps (People > Invites on the phone and on the web), in the member's language.
 *
 * Plain words for a friend who has never heard of BeanPool: no "node", no "URL". The link first; then what to do if the link
 * doesn't open (install the app and paste the code); then the community's address, for a phone whose app asks for it.
 */
import { t } from './words.js';

/** `name` is the community's name, or its address where it has none; `address` the community's address (host, no scheme). */
export function inviteShareText(p: { name: string; link: string; code: string; address: string }): string {
    return t(
        "Join my BeanPool community, {name}:\n{link}\n\nIf the link doesn't open, install BeanPool from beanpool.org and paste this code:\n{code}\n\nCommunity address: {address}",
        { name: p.name, link: p.link, code: p.code, address: p.address },
    );
}

/** A community's address as a friend reads it: the host (and port), with no scheme and no trailing slash. */
export function shareAddress(origin: string): string {
    return origin.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}
