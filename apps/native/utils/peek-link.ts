/**
 * A post shared outside its community, from a link (front doors S6, app/peek.tsx):
 *   - the link a member shares, `https://<community>/?post=<id>&peek=<ticket>` (@beanpool/core peekLink), which the app
 *     claims on every *.beanpool.org host (path "/");
 *   - `beanpool://peek?node=<https origin>&post=<id>&peek=<ticket>`, the node's share page's "Open in the BeanPool app"
 *     (apps/server routes/peek.ts), for a self-hosted community's address or an iPhone.
 * A link only OPENS the screen: it signs nothing and sends nothing. The screen reads the one post itself, as a visitor.
 *
 * Kept free of the screens' imports and of the phone's storage, so the router can tell the link without loading either.
 */
import { isPeekPostId, isPeekTicket, peekFromLink } from '@beanpool/core';
import { communityOrigin } from './community-origin';

/** The peek screen's route. */
export const PEEK_ROUTE = '/peek';

/** The website itself, which the app also claims for its own paths: never a community. */
const SITE_HOSTS = new Set(['beanpool.org', 'www.beanpool.org']);

/** `beanpool://peek…` in the spellings a system hands over (as utils/community-card-link.ts reads its own). */
const APP_PATH = /^(?:beanpool:\/\/\/?|\/)?peek\/?(?:\?([^#]*))?(?:#.*)?$/i;

/** The peek screen's route for a community's origin, a post and a ticket. */
export function peekRoute(origin: string, postId: string, ticket: string): string {
    return `${PEEK_ROUTE}?node=${encodeURIComponent(origin)}&post=${encodeURIComponent(postId)}&peek=${encodeURIComponent(ticket)}`;
}

/** The community, the post and the ticket a link names, each checked, or null. */
export function peekFromSystemPath(path: unknown): { origin: string; postId: string; ticket: string } | null {
    if (typeof path !== 'string') return null;
    const s = path.trim();
    const app = APP_PATH.exec(s);
    if (app) {
        const q = new URLSearchParams(app[1] ?? '');
        const nodes = q.getAll('node');
        const origin = nodes.length === 1 ? communityOrigin(nodes[0]) : null;
        const peek = peekFromLink(`?${app[1] ?? ''}`);
        return origin && peek ? { origin, ...peek } : null;
    }
    if (!/^https:\/\//i.test(s)) return null;
    let url: URL;
    try {
        url = new URL(s);
    } catch {
        return null;
    }
    if (url.pathname !== '/' || url.username || url.password || SITE_HOSTS.has(url.hostname.toLowerCase())) return null;
    const origin = communityOrigin(`https://${url.host}`);
    const peek = peekFromLink(s);
    return origin && peek ? { origin, ...peek } : null;
}

/** Whether `path` is a peek link at all (the router then opens the screen, or, for one that names nothing, nothing new). */
export function isPeekPath(path: unknown): boolean {
    if (typeof path !== 'string') return false;
    const s = path.trim();
    if (APP_PATH.test(s)) return true;
    return /^https:\/\//i.test(s) && /[?&]peek=/.test(s) && /[?&]post=/.test(s);
}

/** The peek screen's route for a peek link, or null where it names no community, post or ticket this phone may read. */
export function peekRouteFromSystemPath(path: unknown): string | null {
    const p = peekFromSystemPath(path);
    return p ? peekRoute(p.origin, p.postId, p.ticket) : null;
}

/** The screen's own params, checked again: a route can be pushed with anything. */
export function readPeekParams(params: { node?: unknown; post?: unknown; peek?: unknown }): { origin: string; postId: string; ticket: string } | null {
    const origin = communityOrigin(params.node);
    return origin && isPeekPostId(params.post) && isPeekTicket(params.peek) ? { origin, postId: params.post, ticket: params.peek } : null;
}
