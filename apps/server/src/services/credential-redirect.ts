/**
 * A request that carries a credential to another node (the admin password, a replication token, an automation token)
 * never follows a redirect. fetch's default follows one, and to another origin it drops Authorization but keeps every
 * other header, so X-Admin-Password and X-Replication-Token went wherever the node, or a proxy in front of it, pointed,
 * and that origin's answer was read as the node's (a backup, a copy, a take-over envelope). Such a fetch passes
 * `redirect: 'manual'` and hands its answer here before reading anything from it.
 */

/** A redirect refused: its message names the address the node gave; `host` is that address's host, or null (none, or not a URL). */
export class RedirectRefusedError extends Error {
    constructor(message: string, readonly host: string | null) {
        super(message);
        this.name = 'RedirectRefusedError';
    }
}

/** Why this answer is refused, naming the address the node gave (origin and path only), or null when it is no redirect. */
export function redirectRefusal(res: Response, url: string): RedirectRefusedError | null {
    // 304 is "unchanged" (If-None-Match), not a redirect.
    if (res.status < 300 || res.status > 399 || res.status === 304) return null;
    const location = res.headers.get('location');
    let where = 'no address';
    let host: string | null = null;
    if (location) {
        // Origin and path only: a query or fragment the node put in it is never repeated, and URL drops any user:password.
        try { const to = new URL(location, url); where = to.origin + to.pathname; host = to.host || null; } catch { where = 'an address that is not a URL'; }
    }
    return new RedirectRefusedError(`${new URL(url).origin} answered HTTP ${res.status}, a redirect to ${where}. It was not followed: no credential `
        + 'was sent there and nothing from it was read. Set the address the node answers on itself.', host);
}
