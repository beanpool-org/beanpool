/**
 * BeanPool's own addresses, named once (Marty, 14 Nov 2026: "I want the code clean for people using it out in the world").
 *
 * The code names no real community anywhere else: no special case for one of our servers, no example that is one of our
 * towns. What it does keep is the product's defaults, and they live here, each under one name, so a self-hoster sees in
 * one place what points at BeanPool's own servers and changes it in one place:
 *
 * - {@link DEFAULT_GLOBAL_COMMUNITY_URL}: the worldwide community, a product default Marty decided. A node points its
 *   members elsewhere (or nowhere) with env GLOBAL_COMMUNITY_URL (apps/server config/global-community.ts) and reports it
 *   on /api/community/info; an app built by someone else changes this line.
 *
 * scripts/check-no-node-names.mjs allows the global community's address in this file only.
 */

/** The worldwide community anyone can look around and join with one sign-in. `earth.beanpool.org` redirects here. */
export const DEFAULT_GLOBAL_COMMUNITY_URL = 'https://global.beanpool.org';

/** {@link DEFAULT_GLOBAL_COMMUNITY_URL} as a bare host, for the places that compare or print a host. A string cut, not
 *  `new URL`: the phone's URL has no `host` on older React Native. */
export const DEFAULT_GLOBAL_COMMUNITY_HOST = DEFAULT_GLOBAL_COMMUNITY_URL.replace(/^https:\/\//, '');

/**
 * The folder a fleet's backups of one node are kept in, and the key its harvest state is kept under (apps/server
 * services/harvester.ts, and the manager's Topology panel, which reads that state back). The node's own id, which the
 * operator chose when they listed it, with anything but a letter, digit, `-` or `_` made `_`; a node listed without an
 * id is named for the address it answers at (`local-node` for this machine). Never a guess from words in its name:
 * until 14 Nov 2026 a list of our own servers' names was matched against the id, address and name, so a node called
 * "contest" was filed as `test` beside another.
 */
export function fleetNodeSlug(target: string | { id?: string; url?: string; name?: string } | null | undefined): string {
    if (!target) return 'unknown';
    const rawId = typeof target === 'string' ? target : (target.id || '');
    const cleanId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (cleanId) return cleanId;
    const url = typeof target === 'object' ? (target.url || '') : '';
    const host = (/^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]+)/i.exec(url.trim())?.[1] || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return 'local-node';
    return host.replace(/[^a-z0-9_-]/g, '_') || 'unknown';
}
