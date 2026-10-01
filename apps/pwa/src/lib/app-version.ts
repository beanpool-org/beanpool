/**
 * Version comparison and normalization logic for PWA minimum version gating.
 * Reference: apps/native/utils/app-version.ts
 */

/**
 * Drop the decoration we actually understand, then insist on a real dotted version.
 * Strips leading 'v' or 'V' and ensures 1 to 3 numeric dot-separated segments.
 */
export function normaliseVersion(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().replace(/^[vV]\s*/, '');
    if (!/^\d+(\.\d+){0,2}$/.test(trimmed)) return null;
    return trimmed;
}

/**
 * Compares two semantic version strings.
 * Returns true if `local` is strictly older than `required`.
 * If either version cannot be parsed, returns false (safe fallback to avoid false banners).
 */
export function isVersionOlder(local: string, required: string): boolean {
    const a = normaliseVersion(local);
    const b = normaliseVersion(required);
    if (!a || !b) return false;

    const parse = (v: string) => v.split('.').map(n => parseInt(n, 10));
    const localParts = parse(a);
    const requiredParts = parse(b);

    for (let i = 0; i < 3; i++) {
        const l = localParts[i] || 0;
        const r = requiredParts[i] || 0;
        if (l < r) return true;
        if (l > r) return false;
    }
    return false;
}

/**
 * Whether this open page is older than the server it came from: the web app's whole update rule.
 *
 * The web app has no store, no floor and no block. It is the server's own copy, fetched fresh on every page load (no
 * service worker keeps an old one: vite.config.ts `selfDestroying`), so a page loaded today is already the server's
 * version. Only a tab left open across a server upgrade can be behind, and reloading it fixes that. So the page compares
 * itself with the server's own `version` from /api/community/health and, when it is older, offers a reload. It never
 * reads the phone app's floors (`minAppVersion`, `appFloors`): those count the phone app's versions, which are not the
 * web app's, and a reload could never meet them.
 *
 * `detached`: the page talks to a server other than the one that served it (Settings' node address). A reload brings
 * back the copy that served it, not that server's, so it says nothing then. Unparseable versions say nothing either.
 */
export function webAppBehindServer(pageVersion: string, health: { version?: unknown } | null | undefined, detached: boolean): string | null {
    if (detached) return null;
    const server = normaliseVersion(health?.version);
    if (!server) return null;
    return isVersionOlder(pageVersion, server) ? server : null;
}
