/**
 * The worldwide community's one address, in a file that imports nothing, so pure modules (utils/community-origin.ts,
 * and through it utils/home-cards.ts) can name it without loading the phone's storage. utils/node-profile.ts
 * re-exports it, where every other screen reads it.
 */

/** The worldwide community's one address. `earth.beanpool.org` redirects here at Cloudflare. */
export const GLOBAL_NODE_URL = 'https://global.beanpool.org';
