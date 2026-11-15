/**
 * What the web app's page tells search engines. Every path of the web app gets the same page (public/index.html, the
 * shell the app draws itself into), so to a search engine each `/app?lang=xx` was another copy of one page with none
 * named as the one to list (Search Console, 15 Nov: 6,050 pages "Duplicate without user-selected canonical", each the web
 * app on a community's own server: /app?lang=it, ?lang=tr, ?lang= ...). Two rules, for every community's server:
 *
 *   - The front door, /app (with any query, `?lang=` among them; `/app/`; any case the router answers), names one page in
 *     the HTML it serves: `<link rel="canonical" href="<this community's public address>/app">`. The address is the one
 *     the directory and the community's card already give out (state-engine.ts resolvePublicNodeUrl, the community
 *     rules). A server that knows none (a server on a home network, one not yet given an address) sends no canonical:
 *     the request's Host is not trusted for it, and a guess could name an address that is not this community's.
 *   - Every other path that answers with the page (/app/<anything>, and whatever else falls through to it) is a member's
 *     page, which shows a visitor only the sign-in: `X-Robots-Tag: noindex` and `<meta name="robots" content="noindex">`.
 *     So is public/index.html when it is asked for by name (/index.html, served by the static server): the header only,
 *     as that file is streamed as it is on disk.
 *
 * Nothing else is touched: /api, the PWA's files and its service worker, Settings and the manager, `/` (the community's
 * card, the invite page, a post's share page, or a redirect to /app with its query: routes/settings.ts), and robots.txt
 * (on a public forum's server, routes/forum-public.ts: it keeps /app itself open and closes /app/; elsewhere none). A public
 * page outside /app (the forum's public pages, routes/forum-public.ts) is served by its own route and stays as that route makes it.
 */
import fs from 'node:fs';
import type Koa from 'koa';
import { resolvePublicNodeUrl, PUBLIC_URL_RULES } from './state-engine.js';

/** The web app's front door: the one path of it a search engine is asked to list. */
export const WEB_APP_ENTRY_PATH = '/app';

/** The header and the tag's content on every other path that serves the web app's page. */
export const WEB_APP_NOINDEX = 'noindex';

/** Whether `path` (ctx.path, so no query) is the web app's front door: /app or /app/, in any case the router matches. */
export function isWebAppEntryPath(path: string): boolean {
    const p = path.toLowerCase();
    return p === WEB_APP_ENTRY_PATH || p === `${WEB_APP_ENTRY_PATH}/`;
}

/**
 * The front door's canonical address, `<this community's public origin>/app`, or null when the server knows no public
 * address (or what it holds is not an address), read per request so a change of address is seen at once.
 */
export function webAppCanonicalUrl(): string | null {
    const url = resolvePublicNodeUrl(PUBLIC_URL_RULES.community);
    if (!url) return null;
    try {
        const origin = new URL(url).origin;
        return origin && origin !== 'null' ? `${origin}${WEB_APP_ENTRY_PATH}` : null;
    } catch {
        return null;
    }
}

function attribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `tag` placed in the page's head: before `</head>`, else (a page that leaves its head implied) straight after the
 * doctype, else first. A browser and a crawler read a `<link>` or `<meta>` there as the head's either way.
 */
export function withHeadTag(html: string, tag: string): string {
    const end = html.search(/<\/head\s*>/i);
    if (end >= 0) return `${html.slice(0, end)}${tag}\n${html.slice(end)}`;
    const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
    if (doctype) return `${doctype[0]}${tag}${html.slice(doctype[0].length)}`;
    return `${tag}${html}`;
}

/** The page as served at `path`: the front door's canonical (when there is an address), or every other path's noindex. */
export function webAppPageFor(html: string, path: string, canonical: string | null): { html: string; noindex: boolean } {
    if (isWebAppEntryPath(path)) {
        return { html: canonical ? withHeadTag(html, `<link rel="canonical" href="${attribute(canonical)}">`) : html, noindex: false };
    }
    return { html: withHeadTag(html, `<meta name="robots" content="${WEB_APP_NOINDEX}">`), noindex: true };
}

/**
 * Serves the web app's page (`indexPath`, public/index.html) at ctx.path with the rule above; the caller has set the
 * document policy and counted the visit. False, with nothing set, when the file can't be read.
 */
export async function serveWebAppPage(ctx: Koa.Context, indexPath: string): Promise<boolean> {
    let html: string;
    try {
        html = await fs.promises.readFile(indexPath, 'utf8');
    } catch {
        return false;
    }
    const page = webAppPageFor(html, ctx.path, isWebAppEntryPath(ctx.path) ? webAppCanonicalUrl() : null);
    if (page.noindex) ctx.set('X-Robots-Tag', WEB_APP_NOINDEX);
    ctx.type = 'html';
    ctx.body = page.html;
    return true;
}

/**
 * Whether a file the static server resolved, by its path inside public/, is the web app's page itself (`/index.html`,
 * or its compressed copy): it gets the noindex header, as every path of the web app but the front door does.
 */
export function isWebAppPageFile(relativePath: string): boolean {
    return relativePath.replace(/\\/g, '/').replace(/\.(br|gz)$/, '') === 'index.html';
}
