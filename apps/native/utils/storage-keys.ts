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
 * The key each community signs its push notices with, pinned from the answer to this phone's push registration there
 * (utils/push-pins.ts): an object, community address → key. Kept apart from {@link SAVED_NODES_STORE_KEY} so that no
 * writer of the saved list can overwrite a pin, nor a pin write bring back a community the member forgot; a pin counts
 * only while the phone keeps its community (push-pins.ts `readPushPins`).
 */
export const PUSH_PINS_STORE_KEY = 'beanpool_push_pins';

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
 * (push-registrations.ts `stopRegistering`), or once the phone no longer keeps its community (Forget Community, Wipe
 * Connection), and Sign Out wipes it with the account (utils/identity.ts wipeIdentityScopedStorage).
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

/**
 * iPhone only: the public key whose SecureStore item this phone has made this-device-only (utils/identity.ts
 * `keepKeyOnThisPhone`), so the move runs once per key. Not secret. Kept through Sign Out: a later account's item is made
 * this-device-only as it is written, and a key it doesn't name is simply moved once more.
 */
export const IDENTITY_THIS_DEVICE_STORE_KEY = 'beanpool_identity_this_device_only';

/**
 * A sign-in restore waiting at the key vault (utils/vault.ts): the throwaway key it was started with, the sign-in's
 * subject that opens the copy, and the hold. SecureStore, this device only. Written before the restore goes out, so a
 * lost answer or a restart comes back to the same hold; removed once the account is saved or the restore ends.
 */
export const VAULT_RESTORE_STORE_KEY = 'beanpool_vault_restore';

/** When one account last said "Not now" to moving its sign-in recovery to the key vault (utils/vault.ts). */
export function vaultMoveLaterStoreKey(publicKey: string): string {
    return `beanpool_vault_move_later:${publicKey.toLowerCase()}`;
}

/** Moves to the key vault whose delete at the old community hasn't landed yet (utils/vault-move.ts), tried again. */
export function vaultMoveUnfinishedStoreKey(publicKey: string): string {
    return `beanpool_vault_move_unfinished:${publicKey.toLowerCase()}`;
}

/** The push token one account last gave the key vault (utils/vault.ts `keepVaultPushTokenCurrent`). */
export function vaultPushTokenStoreKey(publicKey: string): string {
    return `beanpool_vault_push_token:${publicKey.toLowerCase()}`;
}

/** Sign-ins one account asked to connect while the key vault was paused, offered again at the next app open. */
export function vaultConnectWantedStoreKey(publicKey: string): string {
    return `beanpool_vault_connect_wanted:${publicKey.toLowerCase()}`;
}

/**
 * What this phone knows about a key vault copy for one account: '1' kept (it deposited one, restored the account from
 * one, or a status read listed one), '0:<ms>' none (a status read listed none, at that time), absent unknown (a restore
 * with the 12 words clears it). The app-open check and the Settings banner skip only a "none" less than a week old
 * (utils/vault.ts `vaultCopyKnowledge`, `VAULT_NONE_KEPT_MS`).
 */
export function vaultCopyKnownStoreKey(publicKey: string): string {
    return `beanpool_vault_copy_known:${publicKey.toLowerCase()}`;
}

/** The key vault holds one account said "Yes, it's me" to on this phone (utils/vault.ts `approvedHolds`). */
export function vaultApprovedHoldsStoreKey(publicKey: string): string {
    return `beanpool_vault_approved_holds:${publicKey.toLowerCase()}`;
}

/**
 * The "one way back" card of an account that joined the global community with 12 words (utils/one-way-back.ts): when it
 * joined, and whether the card was put away or done. Times and flags only. Kept when the account leaves the phone, as
 * its block list is: the same account restored here carries on where it was.
 */
export function oneWayBackStoreKey(publicKey: string): string {
    return `beanpool_one_way_back:${publicKey.toLowerCase()}`;
}

/** The last time the "one way back" card asked the global community about this account, and its answer (one-way-back.ts). */
export function oneWayBackAskedStoreKey(publicKey: string): string {
    return `beanpool_one_way_back_asked:${publicKey.toLowerCase()}`;
}

/**
 * Home (app/(tabs)/index.tsx, utils/home-store.ts): one account's last answer from one community, its copy of the layout,
 * an interests save still owed to the node, and whether it has seen the one-time reveal and hint. They hold the
 * account's own things (its Beans, its deals, who wrote to it), so every key starts with {@link HOME_STORE_PREFIX} and
 * Sign Out and a replacing restore wipe them all with the account (utils/identity.ts wipeIdentityScopedStorage): a new
 * Home key needs no line of its own there. Each also names the account, so another account on the phone never reads one.
 */
export const HOME_STORE_PREFIX = 'beanpool_home:';

const homeCommunity = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

export function homeAnswerStoreKey(publicKey: string, url: string): string {
    return `${HOME_STORE_PREFIX}answer:${publicKey.toLowerCase()}:${homeCommunity(url)}`;
}

export function homeLayoutStoreKey(publicKey: string, url: string): string {
    return `${HOME_STORE_PREFIX}layout:${publicKey.toLowerCase()}:${homeCommunity(url)}`;
}

export function homeInterestsOwedStoreKey(publicKey: string, url: string): string {
    return `${HOME_STORE_PREFIX}interests-owed:${publicKey.toLowerCase()}:${homeCommunity(url)}`;
}

/**
 * The phone's copy of the account's interests: the categories starred in the Market's For You and on Home's interests
 * card (utils/home-store.ts, design §4.3), so For You works offline. It holds what one person cares about and names no
 * account, and the first Home landing of an account with none sends it as that account's, so Sign Out and a replacing
 * restore wipe it with the account (utils/identity.ts wipeIdentityScopedStorage).
 */
export const FAV_CATEGORIES_STORE_KEY = 'bp_fav_categories';

/**
 * Home's one-time reveal and its one-line hint (design §6.2), per account: '1' once each has been seen. They go with the
 * account like the rest of Home's keys (PR #1483 fix round 1: everything Home keeps for an account leaves with it), so
 * the same account restored here later sees the hint once more.
 */
export function homeRevealStoreKey(publicKey: string): string {
    return `${HOME_STORE_PREFIX}reveal:${publicKey.toLowerCase()}`;
}

export function homeHintStoreKey(publicKey: string): string {
    return `${HOME_STORE_PREFIX}hint:${publicKey.toLowerCase()}`;
}

/** The one-time line "Home now starts with fewer cards" (CARD-FRAME §2.6), per account, like the hint. */
export function homeFewerStoreKey(publicKey: string): string {
    return `${HOME_STORE_PREFIX}fewer:${publicKey.toLowerCase()}`;
}

/**
 * The Tips card's record, per account (@beanpool/core home-tips.ts `TipsRecord`: the tips seen, the one on the card and
 * the day it was first shown, the dismissal). Per account and phone, not per community, and it leaves with the account.
 */
export function homeTipsStoreKey(publicKey: string): string {
    return `${HOME_STORE_PREFIX}tips:${publicKey.toLowerCase()}`;
}
