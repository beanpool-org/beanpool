/**
 * AsyncStorage keys shared by modules that must agree on them, kept free of imports so any module (and its tests) can
 * use them without loading React Native.
 */

/** The communities this key asked to join (utils/knock.ts). Sign Out wipes it (utils/identity.ts wipeIdentityScopedStorage). */
export const KNOCKS_STORE_KEY = 'beanpool_knocks';

/** The member's one profile copy (utils/canonical-profile.ts). Sign Out wipes it (utils/identity.ts wipeIdentityScopedStorage). */
export const CANONICAL_PROFILE_STORE_KEY = 'beanpool_canonical_profile';

/**
 * Reports this key queued while offline, retried when the app returns (utils/blocklist.ts). Sign Out wipes it
 * (utils/identity.ts wipeIdentityScopedStorage): a node files a report as whoever signs it.
 */
export const PENDING_ABUSE_REPORTS_STORE_KEY = 'beanpool_pending_abuse_reports';
