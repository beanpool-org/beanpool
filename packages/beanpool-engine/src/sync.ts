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
}

export interface PostPhoto {
    post_id: string;
    photo_data: string;
    order_num: number;
    updated_at?: string | null;
}

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
    created_at: string;
    updated_at?: string | null;
}

export interface SyncAccount {
    publicKey: string;
    balance: number;
    lastUpdatedAt: string;
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
}

/**
 * One sign-in account that joined through the open door (apps/server engine/open-join.ts): the row that makes one
 * provider account one identity on this node. Replicated so a promoted standby still refuses an account that already
 * joined. `joinHash` is keyed by the node's own secret (`openJoinSalt`, which travels beside the rows, in
 * `SyncPayload.openJoinSalt`); the raw provider subject and the email were never stored. The address hash the sign-up
 * limiter keeps for a day is NOT here: it is only the limiter's, and a standby has no use for it.
 */
export interface SyncOpenJoin {
    memberPubkey: string;
    provider: string;
    joinHash: string;
    joinedAt: string;
    updatedAt: string;
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
    tombstones?: { tableName: string; rowKey: string; deletedAt: string }[];
    /**
     * `post_id|order_num` for every photo row the exporter left OUT because it could not read the object the
     * row names (storage design §7). Additive and optional: a peer that does not know the field ignores it,
     * and the payload it sees is the same one it saw before.
     *
     * The importer only upserts what it is given, so an omitted row is normally harmless — the replica keeps
     * its own copy. A FORCE-RESYNC is the exception: it clears `post_photos` before importing, so without
     * this list the one case the omission exists for (the replica holds the only readable copy) is the case
     * the resync destroys. `clearReplicatedTables` keeps exactly these rows.
     */
    photosOmitted?: string[];
    /**
     * The main server's node profile record, `nodeProfile` in its node_config, and its switch overrides
     * (`nodeProfile.<switch>` rows), so a standby knows what kind of node it copies (apps/server config/node-profile.ts).
     * Additive and optional like `photosOmitted`: a peer that does not know it ignores it. Signed with the rest.
     */
    nodeProfile?: { profile: 'local' | 'global' | null; overrides: Record<string, string> };
    /**
     * The main server's key for the open door's hashes (its node_config `openJoinSalt`), or null when it has none
     * yet. Without it the `openJoins` rows match nothing: a promoted standby would hash a returning account with a
     * key of its own and let it join again. Secret like the recovery shares beside it; signed with the rest.
     */
    openJoinSalt?: string | null;
    /**
     * Whether the main server's visitors' rows are marked (its node_config `migration_mark_visitors_v1`; apps/server
     * db.ts markExistingVisitors). A standby marks none itself, so this tells it the marks in its copy are the main
     * server's, and a promotion doesn't mark again on less than the main server had. Absent from a main server that
     * predates visitors' rows. Signed with the rest.
     */
    visitorsMarked?: boolean;
    nodeId: string;
    generatedAt?: string;
    signature?: string;
    publicKey?: string;
}

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

export function exportSyncState(
    db: Db,
    nodeId: string,
    since?: string | null,
    commonsBalance = 0
): SyncPayload {
    const delta = typeof since === 'string' && since.length > 0;
    const cursor = new Date().toISOString();
    const sel = (table: string, watermark: string): any[] =>
        delta
            ? db.prepare(`SELECT * FROM ${table} WHERE ${watermark} >= ?`).all(since) as any[]
            : db.prepare(`SELECT * FROM ${table}`).all() as any[];

    // The mute (G3), a person's coarse area (G4) and whether the row is a visitor's travel with the member, so a
    // promoted standby keeps them; rowToMember leaves them out because the member directory is built from it too. This
    // payload goes only to a standby pulling with the replication token or the admin password (routes/backup.ts): the
    // database's own trust.
    const members = (delta
        ? db.prepare("SELECT * FROM members WHERE updated_at >= ?").all(since) as any[]
        : db.prepare("SELECT * FROM members").all() as any[]
    ).map((row): Member => ({
        ...rowToMember(row),
        moderationMutedUntil: row.moderation_muted_until ?? null,
        areaLat: row.area_lat ?? null,
        areaLng: row.area_lng ?? null,
        areaUpdatedAt: row.area_updated_at ?? null,
        isVisitor: !!row.is_visitor,
    }));

    const postRows = sel('posts', 'updated_at');
    const posts: MarketplacePost[] = postRows.map(row => ({
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
        originNode: row.origin_node,
        createdBy: row.created_by ?? undefined,
        pollOptions: row.poll_options
            ? (typeof row.poll_options === 'string' ? (() => { try { return JSON.parse(row.poll_options); } catch { return undefined; } })() : row.poll_options)
            : undefined,
        pollClosesAt: row.poll_closes_at || undefined,
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
    }));

    const photos = sel('post_photos', 'updated_at') as PostPhoto[];
    const projects = sel('projects', 'updated_at') as Project[];

    const ratingRows = sel('ratings', 'created_at');
    const ratings: Rating[] = ratingRows.map(r => ({
        id: r.id,
        targetPubkey: r.target_pubkey,
        raterPubkey: r.rater_pubkey,
        stars: r.stars,
        comment: r.comment || '',
        role: r.role,
        transactionId: r.transaction_id,
        createdAt: r.created_at,
    }));

    const accountRows = db.prepare("SELECT * FROM accounts").all() as any[];
    const accounts: SyncAccount[] = accountRows.map(row => ({
        publicKey: row.public_key,
        balance: row.balance,
        lastUpdatedAt: row.last_updated_at || row.joined_at || new Date().toISOString(),
        lastDemurrageEpoch: row.last_demurrage_epoch,
    }));

    const transactionRows = sel('transactions', 'timestamp');
    const transactions: Transaction[] = transactionRows.map(row => ({
        id: row.id,
        from: row.from_pubkey,
        to: row.to_pubkey,
        amount: row.amount,
        memo: row.memo || '',
        timestamp: row.timestamp,
        authSigner: row.auth_signer ?? null,
        authSignature: row.auth_signature ?? null,
        authPayload: row.auth_payload ?? null,
    }));

    const ratingTxKeys = new Set(
        (db.prepare("SELECT transaction_id, rater_pubkey FROM ratings").all() as any[])
            .map(r => `${r.transaction_id}|${r.rater_pubkey}`)
    );

    const marketplaceTxRows = sel('marketplace_transactions', 'updated_at');
    const marketplaceTransactions: SyncMarketplaceTransaction[] = marketplaceTxRows.map(row => ({
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
        ratedByBuyer: ratingTxKeys.has(`${row.id}|${row.buyer_pubkey}`),
        ratedBySeller: ratingTxKeys.has(`${row.id}|${row.seller_pubkey}`),
    }));

    const friendRows = sel('friends', 'updated_at');
    const friends: SyncFriend[] = friendRows.map(row => ({
        ownerPubkey: row.owner_pubkey,
        friendPubkey: row.friend_pubkey,
        addedAt: row.added_at,
        // Always false. `friends.is_guardian` is gone from schema.sql, so a fresh node reads
        // `undefined` here while an existing node still holds legacy 1s — which would make two
        // nodes with identical friendships export different payloads. Guardian recovery is
        // deleted, so the honest value is the same everywhere: nobody is a guardian.
        isGuardian: false,
        updatedAt: row.updated_at || row.added_at,
    }));

    const conversationRows = sel('conversations', 'created_at');
    const conversations: SyncConversation[] = conversationRows.map(row => ({
        id: row.id,
        type: row.type,
        postId: row.post_id,
        name: row.name,
        createdBy: row.created_by,
        createdAt: row.created_at,
    }));

    const participantRows = sel('conversation_participants', 'updated_at');
    const conversationParticipants: SyncConversationParticipant[] = participantRows.map(row => ({
        conversationId: row.conversation_id,
        publicKey: row.public_key,
        lastReadAt: row.last_read_at,
        updatedAt: row.updated_at || row.last_read_at,
    }));

    const messageRows = sel('messages', 'updated_at');
    const messages: Message[] = messageRows.map(row => ({
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
    }));

    const abuseRows = sel('abuse_reports', 'updated_at');
    const abuseReports: SyncAbuseReport[] = abuseRows.map(row => ({
        id: row.id,
        reporterPubkey: row.reporter_pubkey,
        targetPubkey: row.target_pubkey,
        targetPostId: row.target_post_id,
        targetPulseItemId: row.target_pulse_item_id ?? null,
        reason: row.reason,
        createdAt: row.created_at,
        status: row.status || 'pending',
        updatedAt: row.updated_at || row.created_at,
    }));

    // Deleted rows are exported too, and must be: a backup that never hears about the deletion
    // restores the channel. `url`/`handle` are already NULL by then (see deleteChannel), so the
    // tombstone travels without the link travelling with it.
    const channelRows = sel('creator_channels', 'updated_at');
    const creatorChannels: SyncCreatorChannel[] = channelRows.map(row => ({
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
    }));

    let pulseItems: SyncPulseItem[] = [];
    try {
        const pulseItemRows = sel('pulse_items', 'updated_at');
        pulseItems = pulseItemRows.map(row => ({
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
        }));
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

    const recoveryShareRows = sel('recovery_shares', 'updated_at');
    const recoveryShares: SyncRecoveryShare[] = recoveryShareRows.map((row: any) => ({
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
    }));

    // Settlements. Uses the same `sel` cursor helper as every other table, so delta sync picks up a row
    // whose state has moved without re-sending the whole outbox.
    const settlementRows = sel('settlements', 'updated_at');
    const settlements: SyncSettlement[] = settlementRows.map(row => ({
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
    }));

    let pollVotes: SyncPollVote[] = [];
    try {
        const pollVoteRows = sel('poll_votes', 'created_at');
        pollVotes = pollVoteRows.map((r: any) => ({
            postId: r.post_id,
            voterPubkey: r.voter_pubkey,
            optionId: r.option_id,
            signature: r.signature || '',
            createdAt: r.created_at,
        }));
    } catch {
        // Table absent on older schema/fixtures
    }

    // Event RSVPs change (going ↔ interested), so the watermark is updated_at, not created_at. "Not going"
    // is a delete and travels as an `event_rsvps` tombstone.
    let eventRsvps: SyncEventRsvp[] = [];
    try {
        eventRsvps = sel('event_rsvps', 'updated_at').map((r: any) => ({
            postId: r.post_id,
            memberPubkey: r.member_pubkey,
            status: r.status,
            signature: r.signature || '',
            // Undefined rather than null on a schema without the column, so the import can tell "this node
            // does not know about reminders" from "this person has no per-event choice".
            reminderOffsets: r.reminder_offsets === undefined ? undefined : (r.reminder_offsets ?? null),
            updatedAt: r.updated_at,
        }));
    } catch {
        // Table absent on older schema/fixtures
    }

    let groups: SyncGroup[] = [];
    let groupMembers: SyncGroupMember[] = [];
    try {
        groups = sel('groups', 'updated_at').map((r: any) => ({
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
        }));
        groupMembers = sel('group_members', 'updated_at').map((r: any) => ({
            groupId: r.group_id,
            memberPubkey: r.member_pubkey,
            role: r.role,
            status: r.status,
            joinedAt: r.joined_at ?? null,
            invitedBy: r.invited_by ?? null,
            updatedAt: r.updated_at || r.joined_at,
        }));
    } catch {
        // Tables absent on older schema/fixtures
    }

    let openJoins: SyncOpenJoin[] = [];
    try {
        openJoins = (delta
            ? db.prepare('SELECT member_pubkey, provider, join_hash, joined_at, updated_at FROM open_joins WHERE updated_at >= ?').all(since)
            : db.prepare('SELECT member_pubkey, provider, join_hash, joined_at, updated_at FROM open_joins').all()
        ).map((r: any) => ({
            memberPubkey: r.member_pubkey,
            provider: r.provider,
            joinHash: r.join_hash,
            joinedAt: r.joined_at,
            updatedAt: r.updated_at || r.joined_at,
        }));
    } catch {
        // Table absent on older schema/fixtures
    }

    // The global node's place watches and its mirror of the directory (G5). Both tables exist on every node and are
    // empty on a local one.
    let placeWatches: SyncPlaceWatch[] = [];
    try {
        placeWatches = sel('place_watches', 'updated_at').map((r: any) => ({
            id: r.id,
            pubkey: r.pubkey,
            lat: r.lat,
            lng: r.lng,
            radiusKm: r.radius_km,
            createdAt: r.created_at,
            lastNotifiedAt: r.last_notified_at ?? null,
            updatedAt: r.updated_at,
        }));
    } catch {
        // Table absent on older schema/fixtures
    }
    let directoryCache: SyncDirectoryCommunity[] = [];
    try {
        directoryCache = sel('directory_cache', 'updated_at').map((r: any) => ({
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
        }));
    } catch {
        // Table absent on older schema/fixtures
    }

    // Requests to join (G6): on every node, empty on the global one. Never `ip_hash`, the knock limiter's for a day.
    let joinRequests: SyncJoinRequest[] = [];
    try {
        joinRequests = sel('join_requests', 'updated_at').map((r: any) => ({
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
        }));
    } catch {
        // Table absent on older schema/fixtures
    }

    const tombstoneRows = delta
        ? db.prepare("SELECT table_name, row_key, deleted_at FROM tombstones WHERE deleted_at >= ?").all(since) as any[]
        : db.prepare("SELECT table_name, row_key, deleted_at FROM tombstones").all() as any[];
    const tombstones = tombstoneRows.map(t => ({ tableName: t.table_name, rowKey: t.row_key, deletedAt: t.deleted_at }));

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
        tombstones,
    };
}
