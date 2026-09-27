/**
 * AsyncStorage keys shared by modules that must agree on them, kept free of imports so any module (and its tests) can
 * use them without loading React Native.
 */

/** The communities this key asked to join (utils/knock.ts). Sign Out wipes it (utils/identity.ts wipeIdentityScopedStorage). */
export const KNOCKS_STORE_KEY = 'beanpool_knocks';

/** The member's one profile copy (utils/canonical-profile.ts). Sign Out wipes it (utils/identity.ts wipeIdentityScopedStorage). */
export const CANONICAL_PROFILE_STORE_KEY = 'beanpool_canonical_profile';

/**
 * The one queue of offline reports the builds before per-account queues kept for the whole phone. When this build
 * starts, blocklist.ts moves the account on the phone's own reports out of it into {@link pendingAbuseReportsStoreKey},
 * stamped with the community the phone is set to then, and removes it; Sign Out and Replace wipe it too
 * (utils/identity.ts wipeIdentityScopedStorage): a node files a report as whoever signs it.
 */
export const PENDING_ABUSE_REPORTS_STORE_KEY = 'beanpool_pending_abuse_reports';

/**
 * Reports one account queued while its node couldn't be reached, retried when the app returns (utils/blocklist.ts),
 * each with the community it was made at: sent only there, and only while that account is on the phone, signed by its
 * key. Kept when the account leaves the phone, with its block list.
 */
export function pendingAbuseReportsStoreKey(publicKey: string): string {
    return `${PENDING_ABUSE_REPORTS_STORE_KEY}:${publicKey.toLowerCase()}`;
}

/**
 * The people one account blocked on this phone: their public keys only (utils/blocklist.ts). Kept when the account
 * leaves the phone (Sign Out, Replace, the node-mismatch delete), so the same account restored here has its blocks back
 * (Marty, 2026-09-27: the list is the account's), and never read while another account is on the phone.
 */
export function blockedUsersStoreKey(publicKey: string): string {
    return `beanpool_blocked_users:${publicKey.toLowerCase()}`;
}

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

/**
 * The registrations the account on the phone still needs, one per community, each with when it may next be tried
 * (utils/push-registrations.ts `retryDueRegistrations`): one that failed (no connection, no answer, an error) is tried
 * again as the app comes back until it lands. Each is dropped as its account starts leaving the phone
 * (push-registrations.ts `stopRegistering`), and Sign Out wipes it with the account (utils/identity.ts
 * wipeIdentityScopedStorage).
 */
export const PUSH_REGISTRATIONS_DUE_STORE_KEY = 'beanpool_push_registrations_due';

/**
 * This phone's last push stamp (utils/push-registrations.ts `nextPushStamp`): each registration and each leave statement
 * takes a later one, whatever the clock does. Phone-wide, not the account's: Sign Out keeps it, so a statement the old
 * account made can never outrank the registration of an account that signs in after it. Kept under this name twice, in
 * AsyncStorage and in SecureStore beside the key, which an iOS reinstall keeps.
 */
export const PUSH_STAMP_STORE_KEY = 'beanpool_push_stamp';

/**
 * The leave statements not yet confirmed by their community (utils/push-leave.ts). Kept when the account leaves the
 * phone, on purpose: they are how its push alerts stop there when the phone had no connection as it left.
 */
export const PUSH_LEAVE_STATEMENTS_STORE_KEY = 'beanpool_push_leave_statements';
