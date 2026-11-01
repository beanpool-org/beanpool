/**
 * AsyncStorage keys shared by modules that must agree on them, kept free of imports so any module (and its tests) can
 * use them without loading React Native.
 */

/** The member's choice on notification permissions (utils/notification-permission.ts). Sign Out and Replace wipe it. */
export const NOTIFICATION_PERMISSION_STORE_KEY = 'beanpool_notification_permission';

/** The communities this key asked to join (utils/knock.ts). Sign Out wipes it (utils/identity.ts wipeIdentityScopedStorage). */
export const KNOCKS_STORE_KEY = 'beanpool_knocks';

/**
 * The public key a knock made on this phone, whose 12 words have never been shown (utils/knock-key.ts `knockKeyIsNew`). Sign
 * Out and Replace wipe it (utils/identity.ts wipeIdentityScopedStorage).
 */
export const KNOCK_KEY_STORE_KEY = 'beanpool_knock_key';

/**
 * What the background sync last saw of the community's open requests to join, for the account on it (`{ community,
 * publicKey, count }`; utils/sync-notices.ts). Sign Out wipes it (utils/identity.ts wipeIdentityScopedStorage).
 */
export const ADMIN_KNOCKS_COUNT_STORE_KEY = 'beanpool_admin_knocks_last_count';

/**
 * The account's role on its community as `GET /api/node-admin/me` last said it, and when (`{ community, publicKey, role,
 * at }`; utils/sync-notices.ts). Sign Out wipes it (utils/identity.ts wipeIdentityScopedStorage).
 */
export const KNOCK_ROLE_STORE_KEY = 'beanpool_knock_role_checked';

/**
 * The offer to bring a member's listings to the community they joined, or that their key has had its one
 * (utils/bring-listings.ts). Sign Out wipes it (utils/identity.ts wipeIdentityScopedStorage).
 */
export const BRING_LISTINGS_STORE_KEY = 'beanpool_bring_listings';

/** A town typed in "Find your community" (utils/typed-place.ts): where the member lives, roughly. Sign Out wipes it. */
export const TYPED_PLACE_STORE_KEY = 'beanpool_find_typed_place';

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
 * Which of one account's blocks this phone has put on each community's own list for it (utils/blocklist.ts `syncBlocks`):
 * an object, community address → `{ on, sent, waitUntil? }`. Kept with {@link blockedUsersStoreKey}, the list it
 * describes, when the account leaves the phone, so the same account restored here still takes off a community's list
 * the blocks it lifted; never read for another account.
 */
export function communityBlocksStoreKey(publicKey: string): string {
    return `beanpool_community_blocks:${publicKey.toLowerCase()}`;
}

/** Every {@link messageRequestsStoreKey} key starts with this. */
export const MESSAGE_REQUESTS_STORE_PREFIX = 'beanpool_message_requests:';

/**
 * The message requests waiting for one account in one community file, as that community's node last listed them (utils/db.ts
 * saveMessageRequests): one value per (account, file), as every other piece of a community's conversations is kept apart,
 * so a switch of community never shows another's strangers, nor sends their ids to this one's node (PR #2540 review
 * 4394120364). `file`: the name db.ts opens the community under. A copy the next sync replaces, naming who wrote to the
 * account: Sign Out and Replace wipe every one by {@link MESSAGE_REQUESTS_STORE_PREFIX} (utils/identity.ts
 * wipeIdentityScopedStorage; review 4394671101).
 */
export function messageRequestsStoreKey(publicKey: string, file: string): string {
    return `${MESSAGE_REQUESTS_STORE_PREFIX}${publicKey.toLowerCase()}:${file}`;
}

/**
 * The key each of one account's direct messages in one community file is sealed to, as this phone pinned it
 * (utils/dm-peer-pins.ts): `{ pins }`, conversation id lower-cased → pin. One value per (account, file), so no community's
 * node can grow another's or reach its pins (§3.4 amendment 6); its presence is the record that the update's seed of that
 * file ran. Outside SQLite, so no sync, prune or wipe-and-fetch of the conversation rows can move it. Kept when the account
 * leaves the phone, as its block list is (Marty, 13 Oct), and never read for another account. `file`: the name db.ts opens
 * the community under.
 */
export function dmPeerPinsStoreKey(publicKey: string, file: string): string {
    return `beanpool_dm_peer_pins:${publicKey.toLowerCase()}:${file}`;
}

/**
 * What the member's reset of one community's chat memory set aside (utils/dm-peer-pins.ts, §3.4 amendment 6 §3): the raw
 * pins value as storage returned it, the newest kept. Never read by the app; kept for the record, as the pins are.
 */
export function dmPeerPinsSetAsideStoreKey(publicKey: string, file: string): string {
    return `beanpool_dm_peer_pins_set_aside:${publicKey.toLowerCase()}:${file}`;
}

/**
 * The conversations one account's phone has seen as DMs in one community file (utils/dm-guard-list.ts, the DM guard: §3.4
 * amendment 7 §3): a JSON array of ids as the node spelt them. One value per (account, file), beside the pins, so one
 * community's node can neither grow another's list nor make it forget a DM; seeded once from that file's own `dm` rows.
 * `file`: the name db.ts opens the community under.
 */
export function dmConversationsSeenStoreKey(publicKey: string, file: string): string {
    return `beanpool_dm_conversations_seen:${publicKey.toLowerCase()}:${file}`;
}

/**
 * Where the member's reset of one community file's DM guard list (§3.4 amendment 8) keeps the value it replaced, as storage
 * returned it, the newest kept. Never read by the app, as the pins' set-aside isn't.
 */
export function dmConversationsSeenSetAsideStoreKey(publicKey: string, file: string): string {
    return `beanpool_dm_conversations_seen_set_aside:${publicKey.toLowerCase()}:${file}`;
}

/**
 * The encrypted lines one account's phone held, at the update, in one community file, of each DM its rows there didn't pin
 * (utils/db.ts, the update's seed of that file, §3.4 amendment 5): an object, conversation id lower-cased → those lines.
 * Written the first time a build with pins reads that file for the account and never overwritten (only shrunk), so a DM
 * judged in a later run is judged on what the phone held then, not on what the node wrote since; one key per file, so a
 * conversation id two communities share is judged in each on its own lines. Kept with {@link dmPeerPinsStoreKey} when the
 * account leaves the phone, and never read for another account. `file`: the name db.ts opens the community under.
 */
export function dmLinesAtUpdateStoreKey(publicKey: string, file: string): string {
    return `beanpool_dm_lines_at_update:${publicKey.toLowerCase()}:${file}`;
}

/**
 * Every key above kept per (account, community file): what goes with a community's copy when it moves to its new address
 * (utils/community-copy-carry.ts). A new key per account and file belongs here too, with its add-only way into a value
 * the new address already has (community-copy-carry.ts MERGES), or following a community leaves it behind
 * (community-copy-carry.test.ts reads this file for one missing). The sync cursors (`pillar_sync_<file>_*`,
 * services/pillar-sync.ts) are per file and not per account: the carry moves those by their prefix.
 */
export const PER_FILE_STORE_KEYS: readonly ((publicKey: string, file: string) => string)[] = [
    dmPeerPinsStoreKey, dmPeerPinsSetAsideStoreKey, dmConversationsSeenStoreKey, dmConversationsSeenSetAsideStoreKey, dmLinesAtUpdateStoreKey,
    messageRequestsStoreKey,
];

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
 * How many notices each community this phone keeps sent since the member last had it open (utils/notice-counts.ts): an
 * object, community address → its count and the notice ids it has seen. Sign Out wipes it (utils/identity.ts
 * wipeIdentityScopedStorage): the notices were the account's.
 */
export const NOTICE_COUNTS_STORE_KEY = 'beanpool_notice_counts';

/**
 * A profile change waiting to reach a community (utils/pending-profile-sync.ts): one key per community, this prefix and
 * its address in one spelling (node-url.ts plainOriginOf). Sign Out wipes them (utils/identity.ts
 * wipeIdentityScopedStorage): the changes were the account's.
 */
export const PENDING_PROFILE_STORE_PREFIX = 'beanpool_pending_profile:';

/**
 * What a community said when it refused for good a name waiting to reach it (utils/pending-profile-sync.ts), kept until
 * Settings has said it: this prefix and the community's address in one spelling. It starts with
 * PENDING_PROFILE_STORE_PREFIX, so Sign Out wipes it with the changes.
 */
export const PENDING_PROFILE_REFUSAL_STORE_PREFIX = `${PENDING_PROFILE_STORE_PREFIX}refused:`;

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
 * The communities the member turned alerts off for, one switch per community, default on (utils/push-registrations.ts):
 * this phone's token is not registered with these. A community leaves the list as it leaves the phone, and a followed
 * one keeps its place on it at its new address. Sign Out wipes it with the account (utils/identity.ts
 * wipeIdentityScopedStorage).
 */
export const PUSH_ALERTS_OFF_STORE_KEY = 'beanpool_push_alerts_off';

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

/**
 * The rule for where members' copies go that one account last saw in each of its communities (utils/copies-rule.ts),
 * as JSON `{ <community address>: <rule> }`: a rule that differs from it shows Home's "rule changed" card once.
 */
export function copiesRuleSeenStoreKey(publicKey: string): string {
    return `beanpool_copies_rule_seen:${publicKey.toLowerCase()}`;
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

/**
 * One account's say-so that its 12 words are written down ('1', or '0' once taken back), from "Where your account can be
 * brought back from" (utils/ways-back.ts). A flag only, nothing of the words. Kept when the account leaves the phone, as
 * the "one way back" card is: the paper is the same paper when the account comes back.
 */
export function wordsWrittenDownStoreKey(publicKey: string): string {
    return `beanpool_words_written_down:${publicKey.toLowerCase()}`;
}

/**
 * One account's choice whether a sign-in copy made here also carries its list of communities ('1' or '0'; absent = on,
 * Marty's pick 9 of 27 Oct), from the tick beside Protect with (utils/copy-communities.ts, vault rethink VR5). A flag
 * only, nothing of the list. Kept when the account leaves the phone: it is the member's say, not the phone's.
 */
export function copyListsCommunitiesStoreKey(publicKey: string): string {
    return `beanpool_copy_lists_communities:${publicKey.toLowerCase()}`;
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

/**
 * The phone's list was made while the account's was unknown (an empty version-1 list, as a standby from before the frame
 * answers): the date of that list, so the account's real list, once it answers, wins over it (utils/home-cards.ts
 * pickLayout).
 */
export function homeLayoutPhoneOnlyStoreKey(publicKey: string, url: string): string {
    return `${HOME_STORE_PREFIX}layout-phone-only:${publicKey.toLowerCase()}:${homeCommunity(url)}`;
}

/**
 * With that mark: the dates of the edits the phone sent while marked, so a version-2 answer dated as one is the phone's
 * own save, not the account's real list (utils/home-cards.ts ownMarkedSave). Set and cleared with the mark.
 */
export function homeLayoutPhoneOnlySentStoreKey(publicKey: string, url: string): string {
    return `${HOME_STORE_PREFIX}layout-phone-only-sent:${publicKey.toLowerCase()}:${homeCommunity(url)}`;
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
