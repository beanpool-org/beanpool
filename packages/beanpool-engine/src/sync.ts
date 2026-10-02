// Pure database state export, hash generation, and sync payload types.
//
// Extracted from apps/server/src/state-engine.ts.

import type Database from 'better-sqlite3';
import { parseReachPeers } from '@beanpool/core';

type Db = Database.Database;

import { rowToMember, type Member } from './members.js';
import type { MarketplacePost } from './posts.js';
import type { Rating } from './social.js';
import type { Message } from './messaging.js';

export interface Transaction {
    id: string;
    from: string;
    to: string;
    amount: number;
    taxFee?: number;
    memo: string;
    timestamp: string;
    authSigner?: string | null;
    authSignature?: string | null;
    authPayload?: string | null;
    /** The crowdfund project a pledge, a sweep or a refund belongs to (null when none, or once the project is deleted). */
    projectId?: string | null;
}

export interface PostPhoto {
    post_id: string;
    /**
     * The photo's bytes, as a data URL. Absent from a photo that travels by reference (a copy served in pages, to a standby
     * that reads them: apps/server engine/sync.ts photoRowsByReference), which names its object by `sha256` instead.
     */
    photo_data?: string;
    order_num: number;
    /** As the main server holds it: a standby writes it, never its own clock (apps/server engine/sync.ts importRemoteState). */
    updated_at?: string | null;
    /**
     * A photo by reference: the sha256 (lowercase hex) of its object's bytes, their media type and their size. The standby
     * fetches the object by it (routes/backup.ts sync-object) only when its own store lacks it.
     */
    sha256?: string;
    mime?: string;
    bytes?: number;
}

/** A crowdfund project's row as the main server holds it, every column: a standby's copy is the row verbatim. */
export interface Project {
    id: string;
    creator_pubkey: string;
    title: string;
    description: string | null;
    photos: string | null;
    goal_amount: number;
    current_amount: number;
    deadline_at: string | null;
    status: string;
    /** When the unify migration made it an enterprise (apps/server db/unify-projects-migration.ts), or when it was made as one. */
    migrated_at?: string | null;
    enterprise_pubkey?: string | null;
    created_at: string;
    updated_at?: string | null;
}

export interface SyncAccount {
    publicKey: string;
    balance: number;
    /** As the main server holds it: a standby's copy is its rows verbatim (null only for a row that has none). */
    lastUpdatedAt: string | null;
    lastDemurrageEpoch: number;
}

export interface SyncFriend {
    ownerPubkey: string;
    friendPubkey: string;
    addedAt: string;
    isGuardian: boolean;
    updatedAt?: string | null;
}

export interface SyncConversationParticipant {
    conversationId: string;
    publicKey: string;
    lastReadAt: string | null;
    updatedAt?: string | null;
}

export interface SyncConversation {
    id: string;
    type: string;
    postId: string | null;
    name: string | null;
    createdBy: string | null;
    createdAt: string;
}

export interface SyncAbuseReport {
    id: string;
    reporterPubkey: string;
    targetPubkey: string;
    targetPostId: string | null;
    targetPulseItemId?: string | null;
    reason: string;
    createdAt: string;
    status?: string;
    updatedAt?: string | null;
}

export interface SyncCreatorChannel {
    id: string;
    ownerPubkey: string;
    platform: string;
    /** NULL once deleted — the tombstone carries the fact, never the link. */
    url: string | null;
    handle: string | null;
    category: string;
    isPrimaryVideo: boolean;
    supportsAutolist: boolean;
    oauthVerifiedAt: string | null;
    postCountSeen: number | null;
    autopublish: boolean;
    syndicateToNode: boolean;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
}

export interface SyncPulseItem {
    id: string;
    channelId: string;
    ownerPubkey: string;
    platform: string;
    externalId: string | null;
    /** NULL once deleted — the tombstone carries the fact, never the content. */
    url: string | null;
    title: string | null;
    thumbnailUrl: string | null;
    publishedAt: string | null;
    category: string;
    source: string;
    muted: boolean;
    /** Curated system content. Must cross the wire: a replica that imports it as 0 would
     *  expose it to per-channel retention and lose it on failover. */
    curated: boolean;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
}

export interface SyncRecoveryRequest {
    id: string;
    oldPubkey: string;
    newPubkey: string;
    status: string;
    quorumRequired: number;
    createdAt: string;
    cooldownUntil: string | null;
    executedAt: string | null;
    expiresAt: string | null;
    updatedAt?: string | null;
}

export interface SyncRecoveryApproval {
    requestId: string;
    guardianPubkey: string;
    decision: string;
    createdAt: string;
}

export interface SyncMarketplaceTransaction {
    id: string;
    postId: string;
    post_id?: string;
    buyerPubkey?: string;
    buyerPublicKey?: string;
    buyer_pubkey?: string;
    sellerPubkey?: string;
    sellerPublicKey?: string;
    seller_pubkey?: string;
    credits: number;
    hours: number | null;
    status: string;
    createdAt: string;
    created_at?: string;
    completedAt: string | null;
    completed_at?: string | null;
    updatedAt?: string | null;
    /** The escrow hygiene's last nudge about a lingering deal: copied, or a promoted standby's first run nudges every one again. */
    lastRemindedAt?: string | null;
    /** An admin's resolution of a dispute over the deal, when, and by whom: copied, or it leaves the admin Disputes list. */
    disputeResolution?: string | null;
    disputeResolvedAt?: string | null;
    disputeResolvedBy?: string | null;
    ratedByBuyer?: boolean;
    ratedBySeller?: boolean;
}

/**
 * A cross-node settlement row (#104 §2.5).
 *
 * Replicated because a backup that is promoted to primary inherits the LEDGER EFFECTS of an in-flight
 * settlement — escrow held, a bridge credited — without the row that explains them (review finding). It
 * would then have no way to query, reverse, or pay out that settlement: `recoverSettlements()` would find
 * nothing to recover while the beans sat in escrow forever, and `promotionSanityCheck` would see balances
 * with no counterpart. The whole point of the outbox is that it survives the node.
 */
export interface SyncSettlement {
    key: string;
    direction: string;
    peerId: string;
    buyerPubkey: string;
    buyerHomeNode: string | null;
    sellerPubkey: string | null;
    postId: string | null;
    amount: number;
    fee: number;
    reservedUntil: string | null;
    state: string;
    receipt: string | null;
    receiptPayload: string | null;
    failureReason: string | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * Replicated recovery key share (hub fragment, member fragment, or SSO fragment).
 *
 * Hub fragment A is XOR-mandatory — losing it means ALL keeper-based recovery breaks
 * for every member who has enrolled keepers. Replicating these rows to backup nodes
 * ensures a promoted secondary can still serve recovery without falling back to the
 * file-based VACUUM INTO snapshots (which may be stale by up to 24 hours).
 */
export interface SyncRecoveryShare {
    ownerPubkey: string;
    holderType: string;       // 'hub' | 'member' | 'sso'
    holderRef: string;
    shareIndex: number;
    encryptedShare: string;
    shareIv: string;
    shareTag: string;
    ephemeralPubkey: string | null;
    ssoLookupHash: string | null;
    ssoLookupSalt: string | null;
    kdfParams: string | null;
    generation: number;
    createdAt: string;
    updatedAt: string;
}

/**
 * Replicated 6-digit Recovery PIN state.
 *
 * Protects the friend list from contact harvesting without locking the user out.
 * Replicated to backup mirror nodes so promoted secondaries can verify PINs.
 */
export interface SyncRecoveryPin {
    ownerPubkey: string;
    pinHash: string;
    pinSalt: string;
    attempts?: number;
    lastAttemptAt?: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface SyncPollVote {
    postId: string;
    voterPubkey: string;
    optionId: string;
    signature: string;
    createdAt: string;
    /** Whether the voter was a new or 12-word account when they first voted: 1, 0, or null where the node kept none. */
    voterNewOrWords?: number | null;
}

export interface SyncEventRsvp {
    postId: string;
    memberPubkey: string;
    status: 'going' | 'interested';
    signature: string;
    /**
     * This person's reminders for this event: a JSON array of minutes-before-start, or null for "my
     * Settings default applies" (docs/events-on-the-map.md §2.1). Optional, because a snapshot from a node
     * older than reminders carries no such field — the import COALESCEs rather than erasing what it holds.
     */
    reminderOffsets?: string | null;
    updatedAt: string;
}

/**
 * A Commons group (#823). Replicated because a node restored from its mirror would otherwise come back with no
 * groups at all — and every group-only post pointing at a group that no longer exists.
 */
export interface SyncGroup {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    avatarUrl: string | null;
    category: string;
    createdBy: string;
    /**
     * The group's lead convenor (2026-09-23). Replicated with the group: a node restored from its mirror must
     * come back knowing who leads each group, or the fallback would hand the lead to whoever joined earliest.
     * Null from a node older than this change — the importer leaves the local column alone in that case.
     */
    leadPubkey: string | null;
    joinPolicy: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * One membership row, every status included: a 'removed' row is what keeps a removal in force, and a pending
 * request or open invitation is state a restored node must not forget. Leaving deletes the row and travels as
 * a `group_members` tombstone keyed `groupId|memberPubkey`.
 */
export interface SyncGroupMember {
    groupId: string;
    memberPubkey: string;
    role: string;
    status: string;
    joinedAt: string | null;
    invitedBy: string | null;
    updatedAt: string;
    /** When the row took its role (group_members.role_since). Absent from a node older than the column. */
    roleSince?: string | null;
}

/**
 * One sign-in account that joined through the open door (apps/server engine/open-join.ts): the row that makes one
 * provider account one identity on this node. Replicated so a server that takes over still refuses an account that
 * already joined. `joinHash` is keyed by the node's own secret, which is a file beside its database and never travels
 * here (only which key it is, `SyncPayload.openJoinKeyId`): without it the rows match nothing. The raw provider subject
 * and the email were never stored. The address hash the sign-up limiter keeps for a day is NOT here: it is only the
 * limiter's, and a standby has no use for it.
 */
export interface SyncOpenJoin {
    memberPubkey: string;
    provider: string;
    joinHash: string;
    joinedAt: string;
    updatedAt: string;
    /**
     * A random label shared by the members who joined from one address within a day of each other, so that the server
     * that takes over still counts them as one reporter (auto-hide). Never the address. Null for a join from before the
     * label, or one released by a deleted account; a main server from before it sends none.
     */
    joinCohort?: string | null;
}

/**
 * A member's place watch on the global node (G5, apps/server engine/place-watches.ts): "tell me when a community starts
 * near here". The 0.1° cell, never the spot. Replicated because nothing re-creates a watch: the member set it once.
 * `lastNotifiedAt` is the member's quiet day, so a server that takes over doesn't tell them twice in a day. Watermarked
 * on `updatedAt`; a removal travels as a `place_watches` tombstone keyed by `id`.
 */
export interface SyncPlaceWatch {
    id: string;
    pubkey: string;
    lat: number;
    lng: number;
    radiusKm: number;
    createdAt: string;
    lastNotifiedAt: string | null;
    updatedAt: string;
}

/**
 * A request to join this community (G6, apps/server engine/knocks.ts): a stranger's knock, and how a member answered it.
 * Replicated so a server that takes over still has every open knock, the answer to every closed one (a decline's
 * 30-day block, an approval's invite, which the standby makes again from this row since invite codes do not travel),
 * and who answered. `pubkey` is the applicant's key, not a member's. The address hash the knock limiter keeps for a day
 * is NOT here. Watermarked on `updatedAt`. The main server's tidy-up clears what the applicant sent once no member
 * will read it again (stamped, so it travels here) and deletes a row past its windows, with a `join_requests` tombstone.
 */
export interface SyncJoinRequest {
    id: string;
    pubkey: string;
    callsign: string;
    message: string;
    avatar: string | null;
    fromNode: string | null;
    status: string;
    createdAt: string;
    decidedBy: string | null;
    inviteCode: string | null;
    decidedAt: string | null;
    updatedAt: string;
}

/**
 * A moderation notice kept for the member it is for (apps/server engine/kept-notices.ts): what the live notice said (a
 * post hidden, back, removed or cleared; a report's outcome; a pause and its lift), and when that member saw it, so the
 * web app shows it the next time it opens. Never who acted or who reported. Replicated so a server that takes over
 * still shows a member what they have not seen. `data` is the notice's JSON (its kind, the post). Watermarked on
 * `updatedAt`, which a new notice, a seen mark and a re-key stamp; a deletion (the bounds: a member's newest 50, none
 * older than 60 days; a prune; a self-deletion) travels as a `moderation_notices` tombstone keyed by `id`.
 */
export interface SyncModerationNotice {
    id: string;
    recipient: string;
    title: string;
    body: string;
    data: string;
    createdAt: string;
    seenAt: string | null;
    updatedAt: string;
}

/**
 * One key a member blocked (apps/server engine/member-blocks.ts), kept by the community for their account so the web app
 * has it back on any browser. Replicated so a server that takes over still hides whom each member blocked. Watermarked on
 * `updatedAt`, which a block and a re-key's move stamp; a removal travels as a `member_blocks` tombstone, keyed
 * `<ownerPubkey>|<blockedPubkey>` for one unblock and `<ownerPubkey>|*` for a whole list (a clear, a prune, a
 * self-deletion, a re-key's old key: every row of that owner stamped no later), and a row stamped after its tombstone is
 * a block made again.
 */
export interface SyncMemberBlock {
    ownerPubkey: string;
    blockedPubkey: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * A key the main server no longer accepts (apps/server engine/member-wizards.ts): 'rekey_pending' from the moment an
 * operator starts a re-key, 'rekeyed' with the key that replaced it once the re-key completes. Replicated so a server that
 * takes over refuses a lost or stolen phone's key at every door and in the middleware at once, and so a standby follows a
 * re-key (apps/server engine/key-move.ts). Watermarked on `invalidatedAt`, which both writes stamp; the main server never
 * deletes a row.
 */
export interface SyncInvalidatedKey {
    publicKey: string;
    reason: string;
    invalidatedAt: string;
    rekeyedTo: string | null;
}

/**
 * The community's own settings, as its main server holds them (apps/server config/community-settings.ts, design G5).
 * Each field is the main server's value, or null where it has none (the default applies). A field left out is one the
 * main server didn't say: a standby keeps its own. Never the settings that belong to one server: its admin password,
 * replication token, main server's address, TLS or identity epoch, or its admin IP allowlist.
 */
export interface SyncCommunitySettings {
    /** Fields of local-config.json. `gateway` without its admin IP allowlist. */
    localConfig: {
        callsign?: string | null;
        communityName?: string | null;
        location?: { lat: number; lng: number } | null;
        contactEmail?: string | null;
        contactPhone?: string | null;
        currencyType?: 'text' | 'image' | null;
        currencyValue?: string | null;
        thresholds?: Record<string, number> | null;
        gateway?: {
            corsAllowedOrigins?: string[];
            features?: Record<string, boolean>;
            rateLimiting?: { enabled?: boolean; maxRequestsPerMinute?: number };
        } | null;
    };
    /** node_config rows, as stored. The audit baseline is left out where the main server has none. */
    nodeConfig: {
        ledger_audit_baseline?: string;
        ledger_audit_rebaseline_note?: string | null;
        pricing_data_source?: string | null;
        pricing_show_seasonality?: string | null;
        autosnapshot_config?: string | null;
        /** Who may invite: `admins`, or null for any member (apps/server config/door.ts). */
        door?: string | null;
        /** `true` where a confirmation against the names list needs two admins, or null for one (apps/server engine/names-list.ts). */
        names_two_admins?: string | null;
    };
    /** Fields of the `node_config` row's object: the service area and the directory's switches. */
    directory: {
        serviceRadius?: { lat: number; lng: number; radiusKm: number } | null;
        publishLocation?: boolean;
        publishMembers?: boolean;
        publishContactEmail?: boolean;
        publishContactPhone?: boolean;
        publishHealth?: boolean;
        directoryPushIntervalHours?: number;
    };
}

/**
 * One community in the global node's mirror of the public directory registry (G5, apps/server engine/directory-cache.ts),
 * as its hourly run last wrote it: public data, checked field by field. Replicated so a server that takes over knows
 * which communities the old one had already seen (`firstSeenAt`), and tells no watcher about them again. Never deleted:
 * a community that leaves the registry is `listed: false` with every published field null.
 */
export interface SyncDirectoryCommunity {
    key: string;
    listed: boolean;
    name: string | null;
    url: string | null;
    lat: number | null;
    lng: number | null;
    radiusKm: number | null;
    memberCount: number | null;
    contactEmail: string | null;
    contactPhone: string | null;
    registryUpdatedAt: string | null;
    firstSeenAt: string;
    updatedAt: string;
}

/**
 * Who keeps an enterprise (treasury_operators, apps/server state-engine.ts): the lead and each keeper, as the main server
 * holds them. The whole set in every payload, delta or whole (it is small: enterprises × keepers), so a standby applies it
 * as a diff and an unbound keeper needs no tombstone (design G2c).
 */
export interface SyncTreasuryOperator {
    treasuryPubkey: string;
    memberPubkey: string;
    role: string;
    grantedAt: string | null;
    grantedBy: string | null;
    backing: number | null;
    autoPromotedAt: string | null;
}

/**
 * A keeper's pledge of backing to an enterprise (enterprise_pledges): the derived part of its credit floor. Watermarked on
 * `pledgedAt` or `releasedAt`, the only writes a pledge has (a pledge is never deleted; a re-key moves its keys on both
 * servers). Design G2c.
 */
export interface SyncEnterprisePledge {
    id: string;
    keeper: string;
    enterprise: string;
    amount: number;
    pledgedAt: string | null;
    releasedAt: string | null;
}

export interface SyncPayload {
    stateHash?: string;
    cursor?: string;
    members?: Member[];
    posts?: MarketplacePost[];
    photos?: PostPhoto[];
    projects?: Project[];
    ratings?: Rating[];
    accounts?: SyncAccount[];
    transactions?: Transaction[];
    marketplaceTransactions?: SyncMarketplaceTransaction[];
    friends?: SyncFriend[];
    conversations?: SyncConversation[];
    conversationParticipants?: SyncConversationParticipant[];
    messages?: Message[];
    commonsBalance?: number;
    abuseReports?: SyncAbuseReport[];
    creatorChannels?: SyncCreatorChannel[];
    pulseItems?: SyncPulseItem[];
    recoveryRequests?: SyncRecoveryRequest[];
    recoveryApprovals?: SyncRecoveryApproval[];
    recoveryShares?: SyncRecoveryShare[];
    recoveryPins?: SyncRecoveryPin[];
    settlements?: SyncSettlement[];
    pollVotes?: SyncPollVote[];
    eventRsvps?: SyncEventRsvp[];
    groups?: SyncGroup[];
    groupMembers?: SyncGroupMember[];
    /** Watermarked on `updated_at`, which a join, a release and a re-key all stamp. */
    openJoins?: SyncOpenJoin[];
    /** Watermarked on `updated_at`, which a set, a radius change, a notice and a re-key all stamp. Empty on a local node. */
    placeWatches?: SyncPlaceWatch[];
    /** Watermarked on `updated_at`, which the mirror stamps only on a row it changed. Empty on a local node. */
    directoryCache?: SyncDirectoryCommunity[];
    /** Watermarked on `updated_at`, which a knock, a reopened knock, an answer, a scrub and the tidy-up all stamp. Empty on the global node. */
    joinRequests?: SyncJoinRequest[];
    /** Watermarked on `updated_at`, which a new notice, a seen mark and a re-key all stamp. */
    moderationNotices?: SyncModerationNotice[];
    /** Watermarked on `updated_at`, which a block and a re-key's move stamp. Absent from a main server that predates it. */
    memberBlocks?: SyncMemberBlock[];
    /**
     * Watermarked on `invalidated_at`, which a re-key's start and its completion both stamp. Absent from a main server
     * that predates it: a standby then keeps the rows it has.
     */
    invalidatedKeys?: SyncInvalidatedKey[];
    /**
     * Every enterprise's keepers, the whole set in every payload. Absent from a main server that predates it: a standby then
     * keeps the rows it has.
     */
    treasuryOperators?: SyncTreasuryOperator[];
    /** Watermarked on `pledged_at` or `released_at`. Absent from a main server that predates it. */
    enterprisePledges?: SyncEnterprisePledge[];
    tombstones?: { tableName: string; rowKey: string; deletedAt: string }[];
    /**
     * `post_id|order_num` for every photo row the exporter left OUT because it could not read the object the
     * row names (storage design §7), or, sending photos by reference, could not find it in its store. Additive and
     * optional: a peer that does not know the field ignores it,
     * and the payload it sees is the same one it saw before.
     *
     * The importer only upserts what it is given, so an omitted row is normally harmless — the replica keeps
     * its own copy. A WHOLE COPY built in pages is the exception: it goes into a new, empty staging database, so
     * without this list the one case the omission exists for (the replica holds the only readable copy) is the
     * case the copy destroys. The stager (apps/server services/stager.ts) carries exactly these rows over from
     * the replica's own database.
     */
    photosOmitted?: string[];
    /**
     * The main server's node profile record, `nodeProfile` in its node_config, and its switch overrides
     * (`nodeProfile.<switch>` rows), so a standby knows what kind of node it copies (apps/server config/node-profile.ts).
     * Additive and optional like `photosOmitted`: a peer that does not know it ignores it. Signed with the rest.
     */
    nodeProfile?: { profile: 'local' | 'global' | null; overrides: Record<string, string> };
    /**
     * Which key the main server's open-door records (`openJoins`) were made with (its node_config `openJoinKeyId`: a
     * hash of the key, never the key), or null when it records none. The key itself never travels in a payload
     * (apps/server services/open-join-key.ts): a standby keeps this so that, promoted, it checks a sign-in only with
     * that key and otherwise refuses one, rather than let an account already here join twice. Signed with the rest.
     */
    openJoinKeyId?: string | null;
    /**
     * Whether the main server's visitors' rows are marked (its node_config `migration_mark_visitors_v1`; apps/server
     * db.ts markExistingVisitors). A standby marks none itself, so this tells it the marks in its copy are the main
     * server's, and a promotion doesn't mark again on less than the main server had. Absent from a main server that
     * predates visitors' rows. Signed with the rest.
     */
    visitorsMarked?: boolean;
    /**
     * The main server's recovery seal epoch (apps/server services/recovery-seal-key.ts recoverySealEpoch): a random id it
     * makes each time it records clearing its database after sealing members' sign-in recovery copies, so a new one after
     * every rollback past the seal. A standby that cleared under another one clears again, whatever order the servers
     * were updated in. Absent from a main server that predates it or has not recorded its clear. Signed with the rest.
     */
    sealEpoch?: string;
    /**
     * The plain tables (apps/server engine/replication-manifest.ts PLAIN_TABLES_PAYLOAD): in-flight money and governance
     * (keepers' wages owed, Decisions and their ballots, keeper and succession votes, invites, re-key codes, recovery
     * releases, links with other communities) and members' devices and conveniences (push tokens and leave statements,
     * chat mutes, enterprise thread read marks, event reminders sent, the activity list, the pricing guide and its
     * reports), each under its table's name as the main server holds its rows, every column but the ones the manifest
     * leaves out (exportPlainTables). The ballots and the push tokens go to a standby only: this payload is served to a
     * standby's replication token alone. A table absent here is one the main server doesn't send (older
     * than its line in the manifest): a standby keeps its own rows of it. Signed with the rest.
     */
    plainTables?: PlainTableRows;
    /**
     * The community's own settings as the main server holds them (apps/server config/community-settings.ts): its name,
     * place, contacts, currency display, thresholds, gateway, directory choices, audit baseline, pricing and snapshot
     * schedule. A standby keeps the record and applies none of it while it is a standby; a take-over, or a hand
     * promotion, installs it. Additive and optional like `nodeProfile`: a peer that does not know it ignores it, and a
     * standby of a main server that predates it keeps its own. Checked field by field on the way in. Signed with the rest.
     */
    communitySettings?: SyncCommunitySettings;
    nodeId: string;
    generatedAt?: string;
    signature?: string;
    publicKey?: string;
}

/**
 * The tables getStateHash reads, by name. A standby whose copies leave one of them out (more rows than one copy carries,
 * apps/server engine/sync.ts) can't read the hash as drift: it differs until a whole copy carries that table again.
 */
export const STATE_HASH_TABLES: readonly string[] = [
    'members', 'posts', 'creator_channels', 'pulse_items', 'event_rsvps', 'groups', 'group_members',
];

export function getStateHash(db: Db): string {
    const pKeys = db.prepare("SELECT public_key FROM members ORDER BY public_key").all() as any[];
    const pIds = db.prepare("SELECT id FROM posts WHERE active=1 ORDER BY id").all() as any[];
    // Creator channels replicate, so they have to be hashed, or nothing alerts when they stop.
    // LIVE ids only (`deleted_at IS NULL`) — that is what catches both halves of the failure: a
    // channel that never imported is missing here, and a tombstone that never applied leaves the
    // row still live on the replica, i.e. a link the member deleted still published. Counting all
    // rows instead would see those two as identical.
    //
    // Guarded: a backup binary whose schema predates the table is one of the exact scenarios this
    // is meant to catch, and it must report divergence rather than throw and take sync with it.
    let cIds: string[] = [];
    try {
        cIds = (db.prepare("SELECT id FROM creator_channels WHERE deleted_at IS NULL ORDER BY id")
            .all() as any[]).map(r => r.id);
    } catch {
        // Table absent — hashes as empty, which differs from a primary that has any, as it should.
    }
    let piIds: string[] = [];
    try {
        piIds = (db.prepare("SELECT id FROM pulse_items WHERE deleted_at IS NULL ORDER BY id")
            .all() as any[]).map(r => r.id);
    } catch {
        // Table absent on older schema.
    }
    // Event RSVPs. Added to the hashed object ONLY when there are any, so a node that has never hosted an
    // event hashes exactly as it did before events existed and a mixed-version pair does not read as diverged.
    let erKeys: string[] = [];
    try {
        erKeys = (db.prepare("SELECT post_id || '|' || member_pubkey || '|' || status AS k FROM event_rsvps ORDER BY post_id, member_pubkey")
            .all() as any[]).map(r => r.k);
    } catch {
        // Table absent on older schema.
    }
    // Groups and their memberships, with role and status — a removal or a promotion that never reached the
    // replica is exactly the divergence this has to show. Added only when there are any, like RSVPs above.
    let gIds: string[] = [];
    let gmKeys: string[] = [];
    try {
        gIds = (db.prepare("SELECT id FROM groups ORDER BY id").all() as any[]).map(r => r.id);
        gmKeys = (db.prepare("SELECT group_id || '|' || member_pubkey || '|' || role || '|' || status AS k FROM group_members ORDER BY group_id, member_pubkey")
            .all() as any[]).map(r => r.k);
    } catch {
        // Tables absent on older schema.
    }
    const data = JSON.stringify({
        m: pKeys.map(k => k.public_key), p: pIds.map(i => i.id), c: cIds, pi: piIds,
        ...(erKeys.length > 0 ? { er: erKeys } : {}),
        ...(gIds.length > 0 ? { g: gIds } : {}),
        ...(gmKeys.length > 0 ? { gm: gmKeys } : {}),
    });

    let hash = 0;
    for (let i = 0; i < data.length; i++) {
        const char = data.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0;
    }
    return Math.abs(hash).toString(16);
}

/** A plain table the export carries (apps/server engine/replication-manifest.ts PLAIN_TABLES). */
export interface PlainTableSpec {
    table: string;
    watermark: string;
    /** Columns never sent. */
    except?: readonly string[];
    /**
     * When not every row is sent: an SQL condition on the rows that are (the manifest's RowRule), from the server's own
     * code, never from a copy or a request.
     */
    where?: string;
}

/** Each plain table's rows, by table name: every row a record of its columns as the main server holds them. */
export type PlainTableRows = Record<string, Record<string, unknown>[]>;

/** A table or column name this code puts into SQL: a plain identifier, never anything else. */
const SQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name as SQL quotes it. */
const q = (n: string): string => `"${n.replace(/"/g, '""')}"`;

/**
 * How a plain table is read for a copy: its name and watermark, each a plain identifier; its key, from the table itself;
 * its `where`; and each row as it is sent, never a column the spec leaves out. Null for a table this database doesn't have,
 * a watermark it doesn't have, or a name that isn't a plain identifier: such a table is left out of a copy, never sent empty,
 * and a standby keeps its own rows of it. exportPlainTables reads each with it, and so does a copy served in pages (apps/server
 * engine/copy-pages.ts).
 */
export interface PlainTableRead {
    table: string;
    watermark: string;
    /** The primary key's columns, in the key's order. */
    key: string[];
    where: string | null;
    sent: (row: Record<string, unknown>) => Record<string, unknown>;
}

export function plainTableRead(db: Db, { table, watermark, except = [], where }: PlainTableSpec): PlainTableRead | null {
    if (!SQL_NAME.test(table) || !SQL_NAME.test(watermark)) return null;
    const info = db.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table) as { name: string; pk: number }[];
    if (!info.some((c) => c.name === watermark)) return null;
    return {
        table,
        watermark,
        key: info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
        where: where || null,
        sent: except.length === 0 ? (r) => r : (r) => {
            const kept = { ...r };
            for (const c of except) delete kept[c];
            return kept;
        },
    };
}

/**
 * The rows of each plain table, `SELECT *`: those whose watermark is at or after `since`, or every row for a whole copy
 * (no `since`); only the ones its `where` holds, when it has one. In the watermark's order, then the key's, so a standby
 * writes them in the order this server did: a Decision closed before its author opened the next arrives before it,
 * whatever the unique index on open ones would make of the other order. Never a column the spec leaves out. A table this database doesn't have, or a name that isn't a
 * plain identifier, is left out of the answer, never sent empty: a standby keeps its own rows of a table no copy carries.
 */
export function exportPlainTables(db: Db, specs: readonly PlainTableSpec[], since?: string | null): PlainTableRows {
    const delta = typeof since === 'string' && since.length > 0;
    const out: PlainTableRows = {};
    for (const spec of specs) {
        const read = plainTableRead(db, spec);
        if (!read) continue;
        const { table, watermark, where } = read;
        const order = [watermark, ...read.key].map(q).join(', ');
        const held = where ? ` AND (${where})` : '';
        const rows = (delta
            ? db.prepare(`SELECT * FROM ${q(table)} WHERE ${q(watermark)} >= ?${held} ORDER BY ${order}`).all(since)
            : db.prepare(`SELECT * FROM ${q(table)} WHERE 1${held} ORDER BY ${order}`).all()) as Record<string, unknown>[];
        out[table] = rows.map(read.sent);
    }
    return out;
}

// ── Each category's rows as the payload carries them ─────────────────────────────────────────────────────────────────
// One function per category, from its table's row (`SELECT *`): exportSyncState shapes its rows with them, and so does a
// copy served in pages, a slice of rows at a time (EXPORT_CATEGORIES).

/**
 * Each member's preferences (holiday, notification settings, reminder defaults), by key: of the members `keys` names, or
 * of every member. Empty on a schema without the table.
 */
function preferencesOfMembers(db: Db, keys?: readonly string[]): Map<string, Record<string, string>> {
    const preferencesOf = new Map<string, Record<string, string>>();
    try {
        const prefRows = (keys
            ? db.prepare('SELECT public_key, pref_key, pref_value FROM member_preferences WHERE public_key IN (SELECT value FROM json_each(?))').all(JSON.stringify(keys))
            : db.prepare('SELECT public_key, pref_key, pref_value FROM member_preferences').all()
        ) as { public_key: string; pref_key: string; pref_value: string }[];
        for (const r of prefRows) {
            let prefs = preferencesOf.get(r.public_key);
            if (!prefs) preferencesOf.set(r.public_key, prefs = {});
            prefs[r.pref_key] = r.pref_value;
        }
    } catch {
        // Table absent on older schema/fixtures
    }
    return preferencesOf;
}

// The whole row travels as `standing` (design G2a), so a promoted standby is every column of the main server's, and a
// column added later travels without anyone listing it; rowToMember leaves most of them out because the member
// directory is built from it too. The named fields beside it (the mute, the area, the visitor's mark, the owner's
// delete, the board standing) are what a standby older than `standing` reads. This payload goes only to a standby
// pulling with the replication token or the admin password (routes/backup.ts): the database's own trust.
function memberOfRow(row: any, preferencesOf: ReadonlyMap<string, Record<string, string>>): Member {
    const { public_key: _key, updated_at: _stamp, ...standing } = row;
    return {
        ...rowToMember(row),
        moderationMutedUntil: row.moderation_muted_until ?? null,
        areaLat: row.area_lat ?? null,
        areaLng: row.area_lng ?? null,
        areaUpdatedAt: row.area_updated_at ?? null,
        isVisitor: !!row.is_visitor,
        deletedByOwnerAt: row.deleted_by_owner_at ?? null,
        boardStandingChangedAt: row.board_standing_changed_at ?? null,
        standing,
        preferences: preferencesOf.get(row.public_key) ?? {},
    };
}

// Who keeps each enterprise, the whole set every time (design G2c): an unbound keeper is a row the set no longer has.
export function exportTreasuryOperators(db: Db): SyncTreasuryOperator[] {
    try {
        return (db.prepare('SELECT * FROM treasury_operators').all() as any[]).map((r) => ({
            treasuryPubkey: r.treasury_pubkey,
            memberPubkey: r.member_pubkey,
            role: r.role,
            grantedAt: r.granted_at ?? null,
            grantedBy: r.granted_by ?? null,
            backing: r.backing ?? null,
            autoPromotedAt: r.auto_promoted_at ?? null,
        }));
    } catch {
        // Table absent on older schema/fixtures
        return [];
    }
}

function enterprisePledgeOfRow(r: any): SyncEnterprisePledge {
    return {
        id: r.id,
        keeper: r.keeper,
        enterprise: r.enterprise,
        amount: r.amount,
        pledgedAt: r.pledged_at ?? null,
        releasedAt: r.released_at ?? null,
    };
}

function postOfRow(row: any): MarketplacePost {
    return {
        id: row.id,
        type: row.type,
        category: row.category,
        title: row.title,
        description: row.description,
        credits: row.credits,
        priceType: row.price_type || 'fixed',
        authorPublicKey: row.author_pubkey,
        authorCallsign: '',
        createdAt: row.created_at,
        updatedAt: row.updated_at || row.created_at,
        active: Boolean(row.active),
        status: row.status,
        repeatable: Boolean(row.repeatable),
        acceptedBy: row.accepted_by,
        acceptedAt: row.accepted_at,
        pendingTransactionId: row.pending_transaction_id,
        completedAt: row.completed_at,
        lat: row.lat,
        lng: row.lng,
        // Null for this community's own listing, a linked community's address for one in its cache: a standby writes it as
        // it is, so a promoted standby's listings are its own (apps/server engine/sync.ts importRemoteState, design G1).
        originNode: row.origin_node,
        cashAlsoNeeded: !!row.cash_also_needed,
        // This server's search words for it (synonyms included), so a standby's search finds what this one's does.
        searchKeywords: row.search_keywords ?? '',
        createdBy: row.created_by ?? undefined,
        pollOptions: row.poll_options
            ? (typeof row.poll_options === 'string' ? (() => { try { return JSON.parse(row.poll_options); } catch { return undefined; } })() : row.poll_options)
            : undefined,
        pollClosesAt: row.poll_closes_at || undefined,
        // A poll's ballot: an open vote or anonymous (the default), as its creator chose.
        ...(row.type === 'poll' ? { pollOpenVote: row.poll_open_vote === 1 } : {}),
        // Who may see it. Without these a replica takes the column defaults — 'public' and 'local' — so a
        // group-only or direct post would be shown to everyone on a restored node.
        audienceScope: row.audience_scope || 'public',
        targetGroupId: row.target_group_id || undefined,
        targetPubkey: row.target_pubkey || undefined,
        assignedTo: row.assigned_to || undefined,
        reach: row.reach || 'local',
        reachPeers: parseReachPeers(row.reach_peers),
        // Events. The private note replicates like every DM ciphertext does — a backup holds the whole
        // node — and never leaves through the listings pull, which reads its own columns.
        ...(row.type === 'event' ? {
            eventStartAt: row.event_start_at || undefined,
            eventEndAt: row.event_end_at || undefined,
            eventPlaceName: row.event_place_name || undefined,
            eventPrivateNote: row.event_private_note || undefined,
            eventState: row.event_state || undefined,
        } : {}),
        // Moderation (G3): a hidden post stays hidden, and a takedown still counts, on a standby and after a take-over.
        hiddenByReportsAt: row.hidden_by_reports_at ?? null,
        removedByModeratorAt: row.removed_by_moderator_at ?? null,
    };
}

function ratingOfRow(r: any): Rating {
    return {
        id: r.id,
        targetPubkey: r.target_pubkey,
        raterPubkey: r.rater_pubkey,
        stars: r.stars,
        comment: r.comment || '',
        role: r.role,
        transactionId: r.transaction_id,
        createdAt: r.created_at,
    };
}

function accountOfRow(row: any): SyncAccount {
    return {
        publicKey: row.public_key,
        balance: row.balance,
        lastUpdatedAt: row.last_updated_at ?? null,
        lastDemurrageEpoch: row.last_demurrage_epoch,
    };
}

function transactionOfRow(row: any): Transaction {
    return {
        id: row.id,
        from: row.from_pubkey,
        to: row.to_pubkey,
        amount: row.amount,
        // The Commons' fee on the trade and the project it belongs to, so a standby's trades are these ones (the grant cap
        // counts the fees, decisions-engine.ts commonsGrantCap).
        taxFee: row.tax_fee ?? 0,
        projectId: row.project_id ?? null,
        memo: row.memo || '',
        timestamp: row.timestamp,
        authSigner: row.auth_signer ?? null,
        authSignature: row.auth_signature ?? null,
        authPayload: row.auth_payload ?? null,
    };
}

/** `transaction_id|rater_pubkey` of every rating, or of the ratings of the deals `ids` names. */
function ratingKeysOfDeals(db: Db, ids?: readonly string[]): Set<string> {
    return new Set(
        (ids
            ? db.prepare('SELECT transaction_id, rater_pubkey FROM ratings WHERE transaction_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as any[]
            : db.prepare('SELECT transaction_id, rater_pubkey FROM ratings').all() as any[])
            .map(r => `${r.transaction_id}|${r.rater_pubkey}`)
    );
}

function marketplaceTransactionOfRow(row: any, ratingTxKeys: ReadonlySet<string>): SyncMarketplaceTransaction {
    return {
        id: row.id,
        postId: row.post_id,
        buyerPubkey: row.buyer_pubkey,
        buyerPublicKey: row.buyer_pubkey,
        buyer_pubkey: row.buyer_pubkey,
        sellerPubkey: row.seller_pubkey,
        sellerPublicKey: row.seller_pubkey,
        seller_pubkey: row.seller_pubkey,
        credits: row.credits,
        hours: row.hours,
        status: row.status,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        updatedAt: row.updated_at || row.completed_at || row.created_at,
        lastRemindedAt: row.last_reminded_at ?? null,
        disputeResolution: row.dispute_resolution ?? null,
        disputeResolvedAt: row.dispute_resolved_at ?? null,
        disputeResolvedBy: row.dispute_resolved_by ?? null,
        ratedByBuyer: ratingTxKeys.has(`${row.id}|${row.buyer_pubkey}`),
        ratedBySeller: ratingTxKeys.has(`${row.id}|${row.seller_pubkey}`),
    };
}

function friendOfRow(row: any): SyncFriend {
    return {
        ownerPubkey: row.owner_pubkey,
        friendPubkey: row.friend_pubkey,
        addedAt: row.added_at,
        // Always false. `friends.is_guardian` is gone from schema.sql, so a fresh node reads
        // `undefined` here while an existing node still holds legacy 1s — which would make two
        // nodes with identical friendships export different payloads. Guardian recovery is
        // deleted, so the honest value is the same everywhere: nobody is a guardian.
        isGuardian: false,
        updatedAt: row.updated_at || row.added_at,
    };
}

// An event's chat is named with the event's title (apps/server engine/event-thread.ts), and a deleted account's event
// is renamed with its post (apps/server engine/post-scrub.ts): a delta carries the chat of each event it carries, so a
// standby's copy of the name goes too, not only at its next whole copy.
const CONVERSATIONS_SINCE = `created_at >= ?
                      OR (type = 'event_thread' AND id IN (SELECT id FROM posts WHERE type = 'event' AND updated_at >= ?))`;

function conversationOfRow(row: any): SyncConversation {
    return {
        id: row.id,
        type: row.type,
        postId: row.post_id,
        name: row.name,
        createdBy: row.created_by,
        createdAt: row.created_at,
    };
}

function participantOfRow(row: any): SyncConversationParticipant {
    return {
        conversationId: row.conversation_id,
        publicKey: row.public_key,
        lastReadAt: row.last_read_at,
        updatedAt: row.updated_at || row.last_read_at,
    };
}

function messageOfRow(row: any): Message {
    return {
        id: row.id,
        conversationId: row.conversation_id,
        authorPubkey: row.author_pubkey,
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        type: row.type,
        systemType: row.system_type,
        metadata: row.metadata || undefined,
        timestamp: row.timestamp,
        editedAt: row.edited_at,
        updatedAt: row.updated_at || row.edited_at || row.timestamp,
    };
}

function abuseReportOfRow(row: any): SyncAbuseReport {
    return {
        id: row.id,
        reporterPubkey: row.reporter_pubkey,
        targetPubkey: row.target_pubkey,
        targetPostId: row.target_post_id,
        targetPulseItemId: row.target_pulse_item_id ?? null,
        reason: row.reason,
        createdAt: row.created_at,
        status: row.status || 'pending',
        updatedAt: row.updated_at || row.created_at,
    };
}

// Deleted rows are exported too, and must be: a backup that never hears about the deletion
// restores the channel. `url`/`handle` are already NULL by then (see deleteChannel), so the
// tombstone travels without the link travelling with it.
function creatorChannelOfRow(row: any): SyncCreatorChannel {
    return {
        id: row.id,
        ownerPubkey: row.owner_pubkey,
        platform: row.platform,
        url: row.url ?? null,
        handle: row.handle ?? null,
        category: row.category,
        isPrimaryVideo: row.is_primary_video === 1,
        supportsAutolist: row.supports_autolist === 1,
        oauthVerifiedAt: row.oauth_verified_at ?? null,
        postCountSeen: row.post_count_seen ?? null,
        autopublish: row.autopublish === 1,
        syndicateToNode: row.syndicate_to_node === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at ?? null,
    };
}

function pulseItemOfRow(row: any): SyncPulseItem {
    return {
        id: row.id,
        channelId: row.channel_id,
        ownerPubkey: row.owner_pubkey,
        platform: row.platform,
        externalId: row.external_id ?? null,
        url: row.url ?? null,
        title: row.title ?? null,
        thumbnailUrl: row.thumbnail_url ?? null,
        publishedAt: row.published_at ?? null,
        category: row.category,
        source: row.source,
        muted: row.muted === 1,
        curated: row.curated === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at ?? null,
    };
}

function recoveryShareOfRow(row: any): SyncRecoveryShare {
    return {
        ownerPubkey: row.owner_pubkey,
        holderType: row.holder_type,
        holderRef: row.holder_ref,
        shareIndex: row.share_index,
        encryptedShare: row.encrypted_share,
        shareIv: row.share_iv,
        shareTag: row.share_tag,
        ephemeralPubkey: row.ephemeral_pubkey ?? null,
        ssoLookupHash: row.sso_lookup_hash ?? null,
        ssoLookupSalt: row.sso_lookup_salt ?? null,
        kdfParams: row.kdf_params ?? null,
        generation: row.generation,
        createdAt: row.created_at,
        updatedAt: row.updated_at || row.created_at,
    };
}

function settlementOfRow(row: any): SyncSettlement {
    return {
        key: row.key,
        direction: row.direction,
        peerId: row.peer_id,
        buyerPubkey: row.buyer_pubkey,
        buyerHomeNode: row.buyer_home_node ?? null,
        sellerPubkey: row.seller_pubkey ?? null,
        postId: row.post_id ?? null,
        amount: row.amount,
        fee: row.fee ?? 0,
        reservedUntil: row.reserved_until ?? null,
        state: row.state,
        receipt: row.receipt ?? null,
        receiptPayload: row.receipt_payload ?? null,
        failureReason: row.failure_reason ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at || row.created_at,
    };
}

function pollVoteOfRow(r: any): SyncPollVote {
    return {
        postId: r.post_id,
        voterPubkey: r.voter_pubkey,
        optionId: r.option_id,
        signature: r.signature || '',
        createdAt: r.created_at,
        voterNewOrWords: r.voter_new_or_words ?? null,
    };
}

function eventRsvpOfRow(r: any): SyncEventRsvp {
    return {
        postId: r.post_id,
        memberPubkey: r.member_pubkey,
        status: r.status,
        signature: r.signature || '',
        // Undefined rather than null on a schema without the column, so the import can tell "this node
        // does not know about reminders" from "this person has no per-event choice".
        reminderOffsets: r.reminder_offsets === undefined ? undefined : (r.reminder_offsets ?? null),
        updatedAt: r.updated_at,
    };
}

function groupOfRow(r: any): SyncGroup {
    return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        description: r.description ?? null,
        avatarUrl: r.avatar_url ?? null,
        category: r.category || 'general',
        createdBy: r.created_by,
        leadPubkey: r.lead_pubkey ?? null,
        joinPolicy: r.join_policy,
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at,
    };
}

function groupMemberOfRow(r: any): SyncGroupMember {
    return {
        groupId: r.group_id,
        memberPubkey: r.member_pubkey,
        role: r.role,
        status: r.status,
        joinedAt: r.joined_at ?? null,
        invitedBy: r.invited_by ?? null,
        updatedAt: r.updated_at || r.joined_at,
        roleSince: r.role_since ?? null,
    };
}

function openJoinOfRow(r: any): SyncOpenJoin {
    return {
        memberPubkey: r.member_pubkey,
        provider: r.provider,
        joinHash: r.join_hash,
        joinedAt: r.joined_at,
        updatedAt: r.updated_at || r.joined_at,
        joinCohort: r.join_cohort ?? null,
    };
}

function placeWatchOfRow(r: any): SyncPlaceWatch {
    return {
        id: r.id,
        pubkey: r.pubkey,
        lat: r.lat,
        lng: r.lng,
        radiusKm: r.radius_km,
        createdAt: r.created_at,
        lastNotifiedAt: r.last_notified_at ?? null,
        updatedAt: r.updated_at,
    };
}

function directoryCommunityOfRow(r: any): SyncDirectoryCommunity {
    return {
        key: r.community_key,
        listed: r.listed === 1,
        name: r.name ?? null,
        url: r.node_url ?? null,
        lat: r.lat ?? null,
        lng: r.lng ?? null,
        radiusKm: r.radius_km ?? null,
        memberCount: r.member_count ?? null,
        contactEmail: r.contact_email ?? null,
        contactPhone: r.contact_phone ?? null,
        registryUpdatedAt: r.registry_updated_at ?? null,
        firstSeenAt: r.first_seen_at,
        updatedAt: r.updated_at,
    };
}

// Requests to join (G6): on every node, empty on the global one. Never `ip_hash`, the knock limiter's for a day.
function joinRequestOfRow(r: any): SyncJoinRequest {
    return {
        id: r.id,
        pubkey: r.pubkey,
        callsign: r.callsign,
        message: r.message,
        avatar: r.avatar ?? null,
        fromNode: r.from_node ?? null,
        status: r.status,
        createdAt: r.created_at,
        decidedBy: r.decided_by ?? null,
        inviteCode: r.invite_code ?? null,
        decidedAt: r.decided_at ?? null,
        updatedAt: r.updated_at,
    };
}

// Moderation notices kept for their member (apps/server engine/kept-notices.ts), and when they saw each one.
function moderationNoticeOfRow(r: any): SyncModerationNotice {
    return {
        id: r.id,
        recipient: r.recipient,
        title: r.title,
        body: r.body,
        data: r.data,
        createdAt: r.created_at,
        seenAt: r.seen_at ?? null,
        updatedAt: r.updated_at,
    };
}

// Each member's block list (apps/server engine/member-blocks.ts): whom they blocked, and when.
function memberBlockOfRow(r: any): SyncMemberBlock {
    return {
        ownerPubkey: r.owner_pubkey,
        blockedPubkey: r.blocked_pubkey,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

// The keys a re-key replaced, or is replacing (apps/server engine/member-wizards.ts). A key is lower case wherever
// this server writes one.
function invalidatedKeyOfRow(r: any): SyncInvalidatedKey {
    return {
        publicKey: r.public_key,
        reason: r.reason,
        invalidatedAt: r.invalidated_at,
        rekeyedTo: r.rekeyed_to ?? null,
    };
}

function tombstoneOfRow(t: any): { tableName: string; rowKey: string; deletedAt: string } {
    return { tableName: t.table_name, rowKey: t.row_key, deletedAt: t.deleted_at };
}

/**
 * A category of the payload as a copy served in pages reads it (apps/server engine/copy-pages.ts): its table, the rows a
 * delta carries, and the code that shapes a slice of its rows (`SELECT *`) into what the payload carries, the code
 * exportSyncState shapes them with.
 */
export interface ExportCategory {
    /** The payload's key. */
    key: keyof SyncPayload;
    table: string;
    /**
     * The rows a delta carries: those whose `watermark` is at or after the cursor; those a condition of their own holds, with
     * the cursor in each of its `sinceParams` places; or every row (`whole`), the accounts: a standby's ledger is this one
     * exactly, so every payload carries the whole set.
     */
    delta: { watermark: string } | { where: string; sinceParams: number } | 'whole';
    /** A slice of the table's rows, `SELECT *`, as the payload carries them. */
    shape: (db: Db, rows: any[]) => unknown[];
}

const eachRow = (of: (row: any) => unknown) => (_db: Db, rows: any[]) => rows.map(of);
const asTheyAre = (_db: Db, rows: any[]) => rows;

/**
 * Every category exportSyncState writes, in its order, but the ones a copy in pages carries otherwise: the keepers
 * (`treasuryOperators`, the whole set, which the importer applies as a difference: exportTreasuryOperators, in one piece),
 * the plain tables (plainTableRead; the payload has them after `enterprisePledges`, before `tombstones`), and the three
 * guardian-recovery categories, always empty. `tombstones` last, as the payload has them.
 */
export const EXPORT_CATEGORIES: readonly ExportCategory[] = [
    {
        key: 'members', table: 'members', delta: { watermark: 'updated_at' },
        shape: (db, rows) => {
            const prefs = preferencesOfMembers(db, rows.map((r) => r.public_key));
            return rows.map((r) => memberOfRow(r, prefs));
        },
    },
    { key: 'posts', table: 'posts', delta: { watermark: 'updated_at' }, shape: eachRow(postOfRow) },
    // The photos' rows as the table holds them: the server puts each one's bytes back, or, in a copy served in pages, names
    // each one's object by reference (apps/server engine/sync.ts).
    { key: 'photos', table: 'post_photos', delta: { watermark: 'updated_at' }, shape: asTheyAre },
    { key: 'projects', table: 'projects', delta: { watermark: 'updated_at' }, shape: asTheyAre },
    { key: 'ratings', table: 'ratings', delta: { watermark: 'created_at' }, shape: eachRow(ratingOfRow) },
    { key: 'accounts', table: 'accounts', delta: 'whole', shape: eachRow(accountOfRow) },
    { key: 'transactions', table: 'transactions', delta: { watermark: 'timestamp' }, shape: eachRow(transactionOfRow) },
    {
        key: 'marketplaceTransactions', table: 'marketplace_transactions', delta: { watermark: 'updated_at' },
        shape: (db, rows) => {
            const rated = ratingKeysOfDeals(db, rows.map((r) => r.id));
            return rows.map((r) => marketplaceTransactionOfRow(r, rated));
        },
    },
    { key: 'friends', table: 'friends', delta: { watermark: 'updated_at' }, shape: eachRow(friendOfRow) },
    { key: 'conversations', table: 'conversations', delta: { where: CONVERSATIONS_SINCE, sinceParams: 2 }, shape: eachRow(conversationOfRow) },
    { key: 'conversationParticipants', table: 'conversation_participants', delta: { watermark: 'updated_at' }, shape: eachRow(participantOfRow) },
    { key: 'messages', table: 'messages', delta: { watermark: 'updated_at' }, shape: eachRow(messageOfRow) },
    { key: 'abuseReports', table: 'abuse_reports', delta: { watermark: 'updated_at' }, shape: eachRow(abuseReportOfRow) },
    { key: 'creatorChannels', table: 'creator_channels', delta: { watermark: 'updated_at' }, shape: eachRow(creatorChannelOfRow) },
    { key: 'pulseItems', table: 'pulse_items', delta: { watermark: 'updated_at' }, shape: eachRow(pulseItemOfRow) },
    { key: 'recoveryShares', table: 'recovery_shares', delta: { watermark: 'updated_at' }, shape: eachRow(recoveryShareOfRow) },
    { key: 'settlements', table: 'settlements', delta: { watermark: 'updated_at' }, shape: eachRow(settlementOfRow) },
    { key: 'pollVotes', table: 'poll_votes', delta: { watermark: 'created_at' }, shape: eachRow(pollVoteOfRow) },
    { key: 'eventRsvps', table: 'event_rsvps', delta: { watermark: 'updated_at' }, shape: eachRow(eventRsvpOfRow) },
    { key: 'groups', table: 'groups', delta: { watermark: 'updated_at' }, shape: eachRow(groupOfRow) },
    { key: 'groupMembers', table: 'group_members', delta: { watermark: 'updated_at' }, shape: eachRow(groupMemberOfRow) },
    { key: 'openJoins', table: 'open_joins', delta: { watermark: 'updated_at' }, shape: eachRow(openJoinOfRow) },
    { key: 'placeWatches', table: 'place_watches', delta: { watermark: 'updated_at' }, shape: eachRow(placeWatchOfRow) },
    { key: 'directoryCache', table: 'directory_cache', delta: { watermark: 'updated_at' }, shape: eachRow(directoryCommunityOfRow) },
    { key: 'joinRequests', table: 'join_requests', delta: { watermark: 'updated_at' }, shape: eachRow(joinRequestOfRow) },
    { key: 'moderationNotices', table: 'moderation_notices', delta: { watermark: 'updated_at' }, shape: eachRow(moderationNoticeOfRow) },
    { key: 'memberBlocks', table: 'member_blocks', delta: { watermark: 'updated_at' }, shape: eachRow(memberBlockOfRow) },
    { key: 'invalidatedKeys', table: 'invalidated_keys', delta: { watermark: 'invalidated_at' }, shape: eachRow(invalidatedKeyOfRow) },
    // Keepers' pledges, by the two writes a pledge has: made, and released.
    { key: 'enterprisePledges', table: 'enterprise_pledges', delta: { where: 'pledged_at >= ? OR released_at >= ?', sinceParams: 2 }, shape: eachRow(enterprisePledgeOfRow) },
    { key: 'tombstones', table: 'tombstones', delta: { watermark: 'deleted_at' }, shape: eachRow(tombstoneOfRow) },
];

export function exportSyncState(
    db: Db,
    nodeId: string,
    since?: string | null,
    commonsBalance = 0,
    plainTables: readonly PlainTableSpec[] = [],
): SyncPayload {
    const delta = typeof since === 'string' && since.length > 0;
    const cursor = new Date().toISOString();
    const sel = (table: string, watermark: string): any[] =>
        delta
            ? db.prepare(`SELECT * FROM ${table} WHERE ${watermark} >= ?`).all(since) as any[]
            : db.prepare(`SELECT * FROM ${table}`).all() as any[];

    // Each member's preferences (holiday, notification settings, reminder defaults) travel with their row, in one query:
    // every writer moves the member's updated_at, so a delta that carries a change carries the member (design G2b).
    const preferencesOf = new Map<string, Record<string, string>>();
    try {
        const prefRows = (delta
            ? db.prepare(`SELECT p.public_key, p.pref_key, p.pref_value FROM member_preferences p
                          JOIN members m ON m.public_key = p.public_key WHERE m.updated_at >= ?`).all(since)
            : db.prepare('SELECT public_key, pref_key, pref_value FROM member_preferences').all()
        ) as { public_key: string; pref_key: string; pref_value: string }[];
        for (const r of prefRows) {
            let prefs = preferencesOf.get(r.public_key);
            if (!prefs) preferencesOf.set(r.public_key, prefs = {});
            prefs[r.pref_key] = r.pref_value;
        }
    } catch {
        // Table absent on older schema/fixtures
    }

    const members = (delta
        ? db.prepare("SELECT * FROM members WHERE updated_at >= ?").all(since) as any[]
        : db.prepare("SELECT * FROM members").all() as any[]
    ).map((row) => memberOfRow(row, preferencesOf));

    const treasuryOperators = exportTreasuryOperators(db);
    let enterprisePledges: SyncEnterprisePledge[] = [];
    try {
        enterprisePledges = (delta
            ? db.prepare('SELECT * FROM enterprise_pledges WHERE pledged_at >= ? OR released_at >= ?').all(since, since)
            : db.prepare('SELECT * FROM enterprise_pledges').all()
        ).map(enterprisePledgeOfRow);
    } catch {
        // Table absent on older schema/fixtures
    }

    const posts: MarketplacePost[] = sel('posts', 'updated_at').map(postOfRow);

    const photos = sel('post_photos', 'updated_at') as PostPhoto[];
    const projects = sel('projects', 'updated_at') as Project[];

    const ratings: Rating[] = sel('ratings', 'created_at').map(ratingOfRow);

    // Every account, in every payload, delta or whole: a standby's ledger is this one exactly (apps/server engine/sync.ts
    // importRemoteState), so it needs the whole set each time, and each row as it is here, its stamp included.
    const accounts: SyncAccount[] = (db.prepare("SELECT * FROM accounts").all() as any[]).map(accountOfRow);

    const transactions: Transaction[] = sel('transactions', 'timestamp').map(transactionOfRow);

    const ratingTxKeys = ratingKeysOfDeals(db);
    const marketplaceTransactions: SyncMarketplaceTransaction[] = sel('marketplace_transactions', 'updated_at')
        .map((row) => marketplaceTransactionOfRow(row, ratingTxKeys));

    const friends: SyncFriend[] = sel('friends', 'updated_at').map(friendOfRow);

    const conversationRows = delta
        ? db.prepare(`SELECT * FROM conversations WHERE ${CONVERSATIONS_SINCE}`).all(since, since) as any[]
        : sel('conversations', 'created_at');
    const conversations: SyncConversation[] = conversationRows.map(conversationOfRow);

    const conversationParticipants: SyncConversationParticipant[] = sel('conversation_participants', 'updated_at').map(participantOfRow);

    const messages: Message[] = sel('messages', 'updated_at').map(messageOfRow);

    const abuseReports: SyncAbuseReport[] = sel('abuse_reports', 'updated_at').map(abuseReportOfRow);

    const creatorChannels: SyncCreatorChannel[] = sel('creator_channels', 'updated_at').map(creatorChannelOfRow);

    let pulseItems: SyncPulseItem[] = [];
    try {
        pulseItems = sel('pulse_items', 'updated_at').map(pulseItemOfRow);
    } catch {
        // pulse_items table may not exist on older test fixtures
    }

    // Guardian recovery is deleted. These three keys stay on the wire as empty arrays so an
    // unpatched peer's `if (remote.recoveryRequests)` ingest still sees the shape it expects and
    // iterates zero times. Querying the tables is pointless now and actively wrong on two counts:
    // a fresh node has no such tables, so every sync cycle threw and swallowed an exception, and
    // an existing node would have gone on replicating rows — PIN hashes included — for a feature
    // that no longer has a single route.
    const recoveryRequests: SyncRecoveryRequest[] = [];
    const recoveryApprovals: SyncRecoveryApproval[] = [];
    const recoveryPins: SyncRecoveryPin[] = [];

    const recoveryShares: SyncRecoveryShare[] = sel('recovery_shares', 'updated_at').map(recoveryShareOfRow);

    // Settlements. Uses the same `sel` cursor helper as every other table, so delta sync picks up a row
    // whose state has moved without re-sending the whole outbox.
    const settlements: SyncSettlement[] = sel('settlements', 'updated_at').map(settlementOfRow);

    let pollVotes: SyncPollVote[] = [];
    try {
        pollVotes = sel('poll_votes', 'created_at').map(pollVoteOfRow);
    } catch {
        // Table absent on older schema/fixtures
    }

    // Event RSVPs change (going ↔ interested), so the watermark is updated_at, not created_at. "Not going"
    // is a delete and travels as an `event_rsvps` tombstone.
    let eventRsvps: SyncEventRsvp[] = [];
    try {
        eventRsvps = sel('event_rsvps', 'updated_at').map(eventRsvpOfRow);
    } catch {
        // Table absent on older schema/fixtures
    }

    let groups: SyncGroup[] = [];
    let groupMembers: SyncGroupMember[] = [];
    try {
        groups = sel('groups', 'updated_at').map(groupOfRow);
        groupMembers = sel('group_members', 'updated_at').map(groupMemberOfRow);
    } catch {
        // Tables absent on older schema/fixtures
    }

    let openJoins: SyncOpenJoin[] = [];
    try {
        openJoins = (delta
            ? db.prepare('SELECT member_pubkey, provider, join_hash, joined_at, updated_at, join_cohort FROM open_joins WHERE updated_at >= ?').all(since)
            : db.prepare('SELECT member_pubkey, provider, join_hash, joined_at, updated_at, join_cohort FROM open_joins').all()
        ).map(openJoinOfRow);
    } catch {
        // Table absent on older schema/fixtures
    }

    // The global node's place watches and its mirror of the directory (G5). Both tables exist on every node and are
    // empty on a local one.
    let placeWatches: SyncPlaceWatch[] = [];
    try {
        placeWatches = sel('place_watches', 'updated_at').map(placeWatchOfRow);
    } catch {
        // Table absent on older schema/fixtures
    }
    let directoryCache: SyncDirectoryCommunity[] = [];
    try {
        directoryCache = sel('directory_cache', 'updated_at').map(directoryCommunityOfRow);
    } catch {
        // Table absent on older schema/fixtures
    }

    let joinRequests: SyncJoinRequest[] = [];
    try {
        joinRequests = sel('join_requests', 'updated_at').map(joinRequestOfRow);
    } catch {
        // Table absent on older schema/fixtures
    }

    let moderationNotices: SyncModerationNotice[] = [];
    try {
        moderationNotices = sel('moderation_notices', 'updated_at').map(moderationNoticeOfRow);
    } catch {
        // Table absent on older schema/fixtures
    }

    let memberBlocks: SyncMemberBlock[] = [];
    try {
        memberBlocks = sel('member_blocks', 'updated_at').map(memberBlockOfRow);
    } catch {
        // Table absent on older schema/fixtures
    }

    let invalidatedKeys: SyncInvalidatedKey[] = [];
    try {
        invalidatedKeys = sel('invalidated_keys', 'invalidated_at').map(invalidatedKeyOfRow);
    } catch {
        // Table absent on older schema/fixtures
    }

    const tombstoneRows = delta
        ? db.prepare("SELECT table_name, row_key, deleted_at FROM tombstones WHERE deleted_at >= ?").all(since) as any[]
        : db.prepare("SELECT table_name, row_key, deleted_at FROM tombstones").all() as any[];
    const tombstones = tombstoneRows.map(tombstoneOfRow);

    return {
        stateHash: getStateHash(db),
        cursor,
        nodeId,
        generatedAt: new Date().toISOString(),
        members,
        posts,
        photos,
        projects,
        ratings,
        accounts,
        transactions,
        marketplaceTransactions,
        friends,
        conversations,
        conversationParticipants,
        messages,
        // EXACT, not rounded to 2dp: a replica that loads a rounded pot cannot balance against the
        // primary's books, and after promotion it would reverse trades using a figure it never held.
        commonsBalance,
        abuseReports,
        creatorChannels,
        pulseItems,
        recoveryRequests,
        recoveryApprovals,
        recoveryShares,
        recoveryPins,
        settlements,
        pollVotes,
        eventRsvps,
        groups,
        groupMembers,
        openJoins,
        placeWatches,
        directoryCache,
        joinRequests,
        moderationNotices,
        memberBlocks,
        invalidatedKeys,
        treasuryOperators,
        enterprisePledges,
        ...(plainTables.length > 0 ? { plainTables: exportPlainTables(db, plainTables, since) } : {}),
        tombstones,
    };
}
