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

/**
 * The QR picture a member shares with an invite (both apps): the file's name, `beanpool-invite-<CODE>.png`. The code is
 * kept to letters, digits and dashes. A self-signed paper ticket is a long string that no file name can hold, and every
 * ticket starts with the same characters, so a long one is named by its first 12 and a hash of the whole ticket: two
 * tickets never share a name (the phone keeps the picture in its cache under this name, and a shared name overwrote it).
 */
export function invitePictureName(code: string): string {
    const safe = code.replace(/[^A-Za-z0-9-]/g, '') || 'code';
    return `beanpool-invite-${safe.length <= 24 ? safe : `${safe.slice(0, 12)}-${hashOf(code)}`}.png`;
}

/** FNV-1a, 32 bits, in base 36: a short name for a long string, the same on every device. Not a secret and not a check. */
function hashOf(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
}

/** The code as the picture prints it under the QR: a short code whole, a long ticket cut after 16 characters (as the card does). */
export function invitePictureCode(code: string): string {
    return code.length > 20 ? `${code.substring(0, 16)}...` : code.toUpperCase();
}
