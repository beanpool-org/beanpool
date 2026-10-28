/**
 * A community's public card from a link (front doors S15, app/community-card.tsx):
 *   - the bare address `https://<community>/`, which the app claims on every *.beanpool.org host (app.json's intent filter
 *     and the associated domains, path "/"): before, the app opened on the member's own Home whichever community the link
 *     named; now it opens that community's card, member or not;
 *   - `beanpool://community-card?node=<https origin>`, the card's own Ask to join on an Android phone's browser (the node's
 *     page at `/`, apps/server routes/community-card.ts).
 * A link only OPENS the screen: it signs nothing and sends nothing. The screen reads the community's public card itself.
 *
 * Kept free of the screens' imports and of the phone's storage, so the router can tell the link without loading either.
 */
import { communityOrigin } from './community-origin';

/** The card screen's route. */
export const COMMUNITY_CARD_ROUTE = '/community-card';

/** The website itself, which the app also claims for its own paths: never a community. */
const SITE_HOSTS = new Set(['beanpool.org', 'www.beanpool.org']);

/** `beanpool://community-card…` in the spellings a system hands over (as utils/global-link.ts reads `global`). */
const APP_PATH = /^(?:beanpool:\/\/\/?|\/)?community-card\/?(?:\?([^#]*))?(?:#.*)?$/i;

/** The card screen's route for a community's origin. */
export function communityCardRoute(origin: string): string {
    return `${COMMUNITY_CARD_ROUTE}?node=${encodeURIComponent(origin)}`;
}

/**
 * Whether `path` is one of the card's links, whatever it names: the router then opens the card, or (for a link that names
 * no community it may read) nothing new.
 */
export function isCommunityCardPath(path: unknown): boolean {
    return typeof path === 'string' && (APP_PATH.test(path.trim()) || bareCommunityOrigin(path) !== null);
}

/**
 * The bare address of a community, `https://<host>/` with nothing after it (a `?lang=` aside), as its origin; null for
 * anything else: a path, a query (an invite, a shared post), a fragment, the website, the global community, http.
 */
function bareCommunityOrigin(path: string): string | null {
    const s = path.trim();
    if (!/^https:\/\//i.test(s)) return null;
    let url: URL;
    try {
        url = new URL(s);
    } catch {
        return null;
    }
    if (url.pathname !== '/' || url.hash || url.username || url.password) return null;
    for (const key of url.searchParams.keys()) if (key !== 'lang') return null;
    if (SITE_HOSTS.has(url.hostname.toLowerCase())) return null;
    return communityOrigin(`https://${url.host}`);
}

/** The card screen's route for one of the card's links, or null when it names no community this phone may read. */
export function cardRouteFromSystemPath(path: unknown): string | null {
    if (typeof path !== 'string') return null;
    const app = APP_PATH.exec(path.trim());
    if (app) {
        const origin = communityOrigin(new URLSearchParams(app[1] ?? '').get('node'));
        return origin ? communityCardRoute(origin) : null;
    }
    const origin = bareCommunityOrigin(path);
    return origin ? communityCardRoute(origin) : null;
}
