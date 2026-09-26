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

/**
 * The communities this phone has been to, for the community switcher (utils/nodes.ts). Sign Out and "Replace this
 * phone's account" remove it with the account (utils/account-leaves-phone.ts).
 */
export const SAVED_NODES_STORE_KEY = 'beanpool_saved_nodes';

/**
 * This phone's push token as last registered for the account on it (services/push-notifications.ts; SecureStore, not
 * AsyncStorage). The account unregisters it on its communities as it leaves the phone (utils/account-leaves-phone.ts).
 */
export const PUSH_TOKEN_STORE_KEY = 'bp_push_token';

/**
 * The communities this phone sent its push token to for the account on it, each recorded as the registration went out
 * (utils/push-registrations.ts). As the account leaves the phone, only these are asked to drop the token
 * (utils/account-leaves-phone.ts). Sign Out wipes it with the account (utils/identity.ts wipeIdentityScopedStorage).
 */
export const PUSH_REGISTERED_AT_STORE_KEY = 'beanpool_push_registered_at';
