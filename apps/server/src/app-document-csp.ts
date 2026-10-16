/**
 * The Content-Security-Policy on this node's documents (design G11 §3.6 change 3, §5.1).
 *
 * Any script that runs on a node's origin can read the member's seed out of IndexedDB. So the web app's document gets
 * a policy under which injected HTML stays text: scripts only from the node itself, and no inline script, inline event
 * handler, `javascript:` URL or third-party script at all. The web app needs nothing more (checked against its built
 * bundle; apps/pwa/e2e/app-csp-check.mjs loads the real build under this header in Chromium and fails on any
 * violation):
 *   style-src    'unsafe-inline' for React's and Leaflet's style attributes
 *   font-src     the node only: Inter is served from the node's own /fonts/ (apps/pwa/public/fonts), never Google's
 *   img-src      data: and blob: (avatars, photo previews); OpenStreetMap's tiles (the map and the location pickers)
 *   connect-src  Nominatim (place search), wss: (the live feed), https: (peer nodes' public routes)
 * and nothing may frame it, change its base URL, embed a plugin, or send a form off the node.
 *
 * This is every node's web app, not only the global node's: a host the web app starts loading has to be added here,
 * or every node blocks it.
 *
 * The node's Settings (the manager, apps/manager, at /settings and /manager) runs under it too (Fable's web review,
 * M2): it is the admin's page on the seed's origin, it needs no inline script and nothing from unpkg, and its one
 * popup (the printable invite cards) is built without one. apps/manager/e2e/phone-width.mjs serves the built manager
 * under this header and fails on any violation.
 *
 * It is the default: every response outside /api and /ws starts with it (https-server.ts). A few pages keep an
 * older header (DOCUMENT_CSP) because they run inline scripts: the static pages under /auth/, the install page an
 * invite link opens at `/?invite=` (routes/invite-trampoline.ts) and the Apple probe when it is on. The old static
 * Settings page (settings.html, /settings-legacy) is gone (design case 18, D9; web-surface review F3), and with it
 * the hosts only it loaded from (unpkg.com's Leaflet, api.qrserver.com's QR images, Cloudflare's analytics beacon). Each gets it from the code that renders it
 * (useDocumentPolicy) or, for a file in public/, from the file the static server resolved (isDocumentPolicyFile);
 * never from how the request's path is spelled, which the static server reads differently (it decodes and then
 * normalises, so `/a/..%2findex.html` is the web app).
 *
 * No imports, so the web app's check can load this file on its own.
 */

export const APP_DOCUMENT_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
    "connect-src 'self' https://nominatim.openstreetmap.org wss: https:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
].join('; ');

/** So a member's path in the web app (a post, a profile) is not handed to the tile host in full. */
export const APP_DOCUMENT_REFERRER_POLICY = 'strict-origin-when-cross-origin';

/**
 * The header those few pages keep: their own inline scripts, and nothing from another host. #131 removed the
 * connect-src wildcard (https: for peer nodes, wss: only); owner-delete S4b removed what only the old Settings page
 * loaded (unpkg.com, static.cloudflareinsights.com, api.qrserver.com).
 */
export const DOCUMENT_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self' https://nominatim.openstreetmap.org wss: https:; frame-ancestors 'none'";

/** A Koa context, or Node's response behind a two-line adapter: whatever a policy is set on. */
interface HeaderTarget {
    set(field: string, value: string): void;
    remove(field: string): void;
}

/** The web app's policy. Every response outside /api and /ws starts with it; the web app's index.html always has it. */
export function useAppDocumentPolicy(target: HeaderTarget): void {
    target.set('Content-Security-Policy', APP_DOCUMENT_CSP);
    target.set('Referrer-Policy', APP_DOCUMENT_REFERRER_POLICY);
}

/** The older policy, called only by the code that renders one of the pages that need it, after it knows it will. */
export function useDocumentPolicy(target: HeaderTarget): void {
    target.set('Content-Security-Policy', DOCUMENT_CSP);
    target.remove('Referrer-Policy');
}

/**
 * Whether a file the static server resolved, by its path inside public/, is one of the pages that need DOCUMENT_CSP:
 * the sign-in returns under auth/. Any other file gets the app document's policy: the web app's index.html above all,
 * the manager's (settings/index.html, manager/index.html), and a settings.html, should one ever be put there (the old
 * static Settings page is gone, design case 18 D9: under this policy its inline script would not run).
 */
export function isDocumentPolicyFile(relativePath: string): boolean {
    const file = relativePath.replace(/\\/g, '/').replace(/\.(br|gz)$/, '');
    return /^auth\/[^/]+\.html$/.test(file);
}

/**
 * Whether a path is spelled so the static server would read it as a different path: an encoded separator (`%2f` or
 * `%5c`, either case), a percent-escape still there after decoding once (`%252f`), a backslash, or, once decoded, a
 * `.` or `..` segment or an empty one (`//`). koa-send decodes the path once and then normalises it, so
 * `/settings/..%2findex.html` is the web app's index.html to it. Nothing the node serves outside /api lives at such a
 * path, so https-server.ts answers them 404 before any page or file handler runs. /api is left alone: its routes
 * take encoded values (a callsign or a feed item's id can hold a `/`).
 */
export function isNonCanonicalSpelling(rawPath: string): boolean {
    let decoded: string;
    try {
        decoded = decodeURIComponent(rawPath);
    } catch {
        return true;
    }
    if (/%2f|%5c/i.test(rawPath) || /%[0-9a-f]{2}/i.test(decoded) || decoded.includes('\\')) return true;
    const segments = decoded.split('/').slice(1);
    return segments.some((s, i) => s === '.' || s === '..' || (s === '' && i < segments.length - 1));
}
