/**
 * The Content-Security-Policy on this node's documents (design G11 §3.6 change 3, §5.1).
 *
 * Any script that runs on a node's origin can read the member's seed out of IndexedDB. So the web app's document gets
 * a policy under which injected HTML stays text: scripts only from the node itself, and no inline script, inline event
 * handler, `javascript:` URL or third-party script at all. The web app needs nothing more (checked against its built
 * bundle; apps/pwa/e2e/app-csp-check.mjs loads the real build under this header in Chromium and fails on any
 * violation):
 *   style-src    'unsafe-inline' for React's and Leaflet's style attributes; Google Fonts' stylesheet
 *   font-src     Google Fonts' files
 *   img-src      data: and blob: (avatars, photo previews); OpenStreetMap's tiles (the map and the location pickers)
 *   connect-src  Nominatim (place search), wss: (the live feed), https: (peer nodes' public routes)
 * and nothing may frame it, change its base URL, embed a plugin, or send a form off the node.
 *
 * This is every node's web app, not only the global node's: a host the web app starts loading has to be added here,
 * or every node blocks it.
 *
 * The other documents keep the header they had (DOCUMENT_CSP): the node's Settings UI, the manager, the static pages
 * under /auth/, and the install page an invite link opens at `/?invite=` (routes/invite-trampoline.ts), whose steps
 * are an inline script.
 *
 * No imports, so the web app's check can load this file on its own.
 */

export const APP_DOCUMENT_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
    "connect-src 'self' https://nominatim.openstreetmap.org wss: https:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
].join('; ');

/** So a member's path in the web app (a post, a profile) is not handed to the tile and font hosts in full. */
export const APP_DOCUMENT_REFERRER_POLICY = 'strict-origin-when-cross-origin';

/** Every other document's policy, unchanged. #131 removed the connect-src wildcard: https: for peer nodes, wss: only. */
export const DOCUMENT_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://unpkg.com https://*.tile.openstreetmap.org https://api.qrserver.com; connect-src 'self' https://nominatim.openstreetmap.org wss: https:; frame-ancestors 'none'";

/**
 * Whether a request's answer can be the web app's document: `/app` and every path the SPA fallback answers with it
 * (`/app…`), `/index.html`, and `/` (a redirect into `/app`), except `/` with an invite code, which is the install page.
 * Decided on the path as the static server reads it (decoded) and ignoring case, so no other spelling of these paths
 * gets the app under the weaker header.
 */
export function isAppDocument(requestPath: string, inviteLink: boolean): boolean {
    let p: string;
    try {
        p = decodeURIComponent(requestPath).toLowerCase();
    } catch {
        p = requestPath.toLowerCase();
    }
    if (p === '/') return !inviteLink;
    return p === '/index.html' || p.startsWith('/app');
}
