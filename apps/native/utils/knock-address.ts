/**
 * Which community a knock goes to, and what it says it came from, for Find a community's address box and Scan a code
 * (DESIGN-account-without-global-fable.md §2.4, slice S3): a stranger who has a community's address (its sign, its
 * website, a friend) asks it directly, with no list of ours in between. Read on the phone alone: nothing here asks an
 * address anything, and nothing here imports a device module.
 */

import { communityOrigin } from './community-origin';
import { GLOBAL_NODE_URL } from './global-node-url';
import { KNOCK_FROM_NODE } from './knock';

/**
 * The community a typed or scanned address names, as a knock would go to it (community-origin.ts `communityOrigin`): a
 * host with a dot, typed bare or with https://, one of its pages, or an app link that names it
 * (`beanpool://community-card?node=https://…`, the open door's and the claim's alike). Null for a word (a name to look
 * for in the list), http, a number on a home network, the global community, or a login in the address.
 */
export function knockAddressFrom(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || s.length > 500 || /\s/.test(s)) return null;
    const app = /^beanpool:\/\/\/?[a-z-]+\/?\?([^#]*)/i.exec(s);
    if (app) {
        const node = /(?:^|&)node=([^&]*)/.exec(app[1]);
        if (!node) return null;
        try { return communityOrigin(decodeURIComponent(node[1])); } catch { return null; }
    }
    if (!/[.:/]/.test(s)) return null;
    return communityOrigin(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
}

/**
 * What Scan a code read: an invite (a code, a paper ticket or an invite link), which the first screen's invite step
 * takes as it is; a community's address ({@link knockAddressFrom}); or nothing this screen can use.
 */
export function knockScanTarget(raw: unknown): { kind: 'invite'; raw: string } | { kind: 'community'; origin: string } | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const s = raw.trim();
    if (/[?&]invite=|\b(?:INV|BP)-[A-Z0-9]{4}-[A-Z0-9]{4}/i.test(s)) return { kind: 'invite', raw: s };
    const origin = knockAddressFrom(s);
    return origin ? { kind: 'community', origin } : null;
}

/**
 * What a knock says it came from (`fromNode`, knock.ts `knockBody`): the global community's name when the community this
 * phone is in is the global one, as a member (`anchorUrl`, and not a visit as a guest); otherwise null, and the body leaves
 * it out. A phone with no community yet, or one in a local community, never says it came from global: a knock is not ours.
 */
export function knockFromNode(anchorUrl: string | null | undefined, guestThere: boolean): string | null {
    const anchor = (anchorUrl ?? '').trim().replace(/\/+$/, '');
    return anchor === GLOBAL_NODE_URL && !guestThere ? KNOCK_FROM_NODE : null;
}
