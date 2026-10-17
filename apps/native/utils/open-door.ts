/**
 * The door screen for any community whose door is open (DESIGN-global-entry-fable.md decision 6, accepted by Marty on
 * 17 Oct 2026; slice P5): app/join-open-door.tsx. With no `node` it is the global community's door, and its old name,
 * `/join-global`, opens the same screen (every way to the global door keeps using it). With `?node=<address>` it is that
 * community's: a self-hoster's node with the global profile and its door open (`openJoin`, not in a private preview) is
 * joined through the same screen, under its own name, with the account on this phone, by the same routes
 * (apps/server routes/open-join.ts) and the same checks. Nothing here assumes our domain: the global community is only the
 * default.
 *
 * - The address must be one the phone will sign for and connect to: a plain `scheme://host[:port]` and nothing after it
 *   (utils/node-url.ts), https, or http only where the cleartext rule allows it (a private address). Anything else is
 *   refused before anything is asked, and the screen says so.
 * - A link only opens the screen (app/+native-intent.ts, {@link doorLinkRoute}): its signed work waits for the member's
 *   first tap (`from=link`), as the global community's own link does (utils/global-link.ts). Nothing joins without the
 *   member's tap, and the key that joins is the phone's own.
 * - The community's name is its own answer (or the phone's saved name for it, or its host), never a link's.
 *
 * Kept free of the screens' imports and of the phone's storage, so the router can read a link without loading either.
 */
import { audienceOf } from '@beanpool/core';
import { GLOBAL_NODE_URL } from './global-node-url';
import { isPlainNodeAddress, plainOriginOf, shouldBlockCleartextNodeUrl } from './node-url';
import { FROM_LINK, globalLinkRoute, type PhoneAtLink } from './global-link';

/** The door screen's route. */
export const OPEN_DOOR_PATH = '/join-open-door';
/** The global community's door by the name every way to it already uses: the same screen, with no `node`. */
export const GLOBAL_DOOR_PATH = '/join-global';

/** The community a door screen is for. */
export interface DoorNode {
    /** Its origin, in one spelling (node-url.ts plainOriginOf). */
    url: string;
    /** It is the global community's address. */
    global: boolean;
}

/**
 * The community at `address`, when the door screen can take it: a plain http(s) origin with nothing after it but a slash,
 * not cleartext to a public host, one core can bind a signature to. Null otherwise.
 */
export function doorNodeAt(address: unknown): DoorNode | null {
    if (typeof address !== 'string') return null;
    const s = address.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s) || !isPlainNodeAddress(s)) return null;
    // A path, a query or a fragment is no community's address (isPlainNodeAddress lets a path through, after a `/`).
    if (s.slice(s.indexOf('//') + 2).includes('/')) return null;
    const origin = plainOriginOf(s);
    if (!origin || shouldBlockCleartextNodeUrl(origin) || !audienceOf(origin)) return null;
    return { url: origin, global: origin === GLOBAL_NODE_URL };
}

/** The screen's `node` param read: the global community when there is none, null for an address it refuses. */
export function doorNodeFromParam(param: string | string[] | undefined): DoorNode | null {
    const raw = Array.isArray(param) ? param[0] : param;
    if (raw === undefined || raw.trim() === '') return { url: GLOBAL_NODE_URL, global: true };
    return doorNodeAt(raw);
}

/**
 * Where a tap goes for the door of the community at `url`: the global community's by its own route; any other's with
 * its address. An address the screen refuses still goes to the screen, which says so: never to another community's door.
 */
export function openDoorHref(url: string): typeof GLOBAL_DOOR_PATH | { pathname: typeof OPEN_DOOR_PATH; params: { node: string } } {
    const door = doorNodeAt(url);
    if (door?.global) return GLOBAL_DOOR_PATH;
    return { pathname: OPEN_DOOR_PATH, params: { node: door ? door.url : url } };
}

/** A link to the door, as the system hands it over. */
export interface DoorLink {
    /** The community it names (the global community when it names none), null when refused. */
    node: DoorNode | null;
    /** What it named, as written, for the screen to say it refused. */
    named: string | null;
}

/**
 * `beanpool://join-open-door[?node=…]` in the spellings a system hands over (`beanpool:///…`, and the bare and `/` path
 * forms). Every other param is dropped: a link carries an address and nothing else. (`beanpool://join-global` is left to
 * Expo Router as before P5: utils/__tests__/global-link.test.ts pins it as no link of its own.)
 */
const DOOR_LINK = /^(?:beanpool:\/\/\/?|\/)?join-open-door\/?(?:\?([^#]*))?(?:#.*)?$/i;

/** The door link in `path`, or null for every other link. */
export function doorLinkFromSystemPath(path: unknown): DoorLink | null {
    if (typeof path !== 'string') return null;
    const m = DOOR_LINK.exec(path.trim());
    if (!m) return null;
    let named: string | null = null;
    for (const part of (m[1] ?? '').split('&')) {
        const eq = part.indexOf('=');
        if (eq < 0 || part.slice(0, eq) !== 'node') continue;
        try { named = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')); } catch { named = ''; }
        break;
    }
    return { node: doorNodeFromParam(named ?? undefined), named };
}

/**
 * Where a door link goes, or null to stay where the member is (cold: as from the icon).
 *
 * - The global community's: as its own link (utils/global-link.ts globalLinkRoute), so every way into it reads the one rule.
 * - Another community's, for a phone with an account and no join wizard left half done: its door, with the work held for
 *   the member's tap. An address the screen refuses opens the screen, which says so (never quietly another door).
 * - With no account, or a wizard half done: as from the icon. A new phone joins another community by its invite; the first
 *   screen's own door is the global community's.
 */
export function doorLinkRoute(link: DoorLink, phone: PhoneAtLink, initial: boolean, nowMs: number): string | null {
    if (link.node?.global) return globalLinkRoute(phone, initial, nowMs);
    if (phone.wizardPending || !phone.account) return initial ? '/' : null;
    const node = link.node ? link.node.url : (link.named ?? '');
    return `${OPEN_DOOR_PATH}?node=${encodeURIComponent(node)}&from=${FROM_LINK}`;
}
