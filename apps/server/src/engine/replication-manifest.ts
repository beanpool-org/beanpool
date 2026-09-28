/**
 * Every table in schema.sql, and every community setting, classified by how a standby holds it: the one place that
 * says what a promoted standby must have of its main server (design: scratch/global-node/DESIGN-standby-takeover-gaps-
 * opus.md §4.2).
 *
 * This is main AS IT IS. Where the design says something should replicate and main does not replicate it yet, the
 * entry says what main does and carries the design's gap id (`gap`); the fix PR for that gap moves the entry, and the
 * twin suite (test-takeover-parity.ts) holds the difference in its KNOWN_GAPS list until then.
 *
 * Checked by test-replication-manifest.ts (every table and column of a fresh database is here) and used by
 * test-takeover-parity.ts (what it compares between a promoted standby and a copy of its main server).
 */

/** A gap in the design's §2; G9 is one the twin suite found (a new standby's first pull, closed with G0). */
export type GapId = 'G0' | 'G1' | 'G1b' | 'G2a' | 'G2b' | 'G2c' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9';

/**
 * A column a replicated table does not carry to its standby. Without `gap` it is local by design and never compared;
 * with one, main drops it today although it should travel, and the twin suite compares it.
 */
export interface ColumnException {
    reason: string;
    gap?: GapId;
}

/**
 * A copied table's `watermark` is how a delta finds a changed row, so every write must move it: a touch trigger that
 * stamps it, or each write setting it. A write that moves nothing reaches a standby only in a whole copy, so the column
 * it writes can't be listed as copied (test-replication-manifest.ts §3 checks the source's writes).
 */
export type TableEntry =
    /** Every column copied with the main server's value. `columns` names them all. `payload`: its SyncPayload key. */
    | { kind: 'replicated'; payload: string; watermark: string; columns: string[]; key?: string[]; clearedByTombstone?: Record<string, TombstoneClear> }
    /** `columns` copied, and the `except` ones not. Between them they name every column. */
    | { kind: 'replicated-except'; payload: string; watermark: string; columns: string[]; key?: string[]; except: Record<string, ColumnException>; clearedByTombstone?: Record<string, TombstoneClear> }
    /** Never copied. With `gap`, main doesn't copy it although the design says it should, and the twin suite compares it. */
    | { kind: 'local'; reason: string; gap?: GapId; key?: string[]; except?: Record<string, ColumnException> }
    /** Not in the sync payload; the take-over bundle brings it (services/takeover-envelope.ts). `bySetting`: a
     *  key-value table whose keys are classified one by one (NODE_CONFIG_KEYS), not compared as rows. */
    | { kind: 'takeover-bundle'; reason: string; bySetting?: true };

/**
 * A copied column the main server sets to NULL, in a write that moves no watermark, when a row it names is deleted; the
 * deletion's tombstone carries the clear, and the standby makes it when it applies that tombstone (engine/sync.ts
 * applyTombstoneLocally). test-replication-manifest.ts accepts that one write, and checks the importer makes the clear.
 */
export interface TombstoneClear {
    /** The tombstones' table_name. */
    tombstone: string;
    reason: string;
}

/** Every payload carries the whole table, so a delta needs no watermark. */
export const WHOLE_SET = 'whole set';

/** Column names, from a space-separated list. */
const cols = (names: string): string[] => names.trim().split(/\s+/);

const STAMPED_BY_STANDBY = "the import doesn't write it, so the standby's own clock stamps it";

/**
 * A members text column the export (rowToMember) and the import both write as `value || null`, so a '' the main server
 * holds is null on the standby. contact_value and contact_visibility share the `|| null` but stay copied: no writer
 * stores '' in them (engine/members.ts updateProfile and db.ts's legacy import write null for an empty one).
 */
const EMPTY_COPIED_AS_NULL = "'' on the main server is null on the standby: the export (rowToMember) and the import write `|| null`";

/**
 * members columns not copied today (engine/sync.ts writes a fixed list, design §2 G2a). The export sends
 * `isTreasury`, `earnedCredit` and `profileUpdatedAt`; the import drops them.
 */
const MEMBERS_STANDING_NOT_COPIED = [
    'can_vouch', 'vouch_credit', 'credit_frozen', 'is_treasury', 'can_operate', 'earned_credit', 'earned_surplus',
    'working_capital_ceiling', 'legacy_credit_floor', 'profile_updated_at', 'purpose', 'goal_amount', 'deadline_at',
    'lifecycle', 'paused', 'paused_at', 'paused_by', 'paused_floor_snapshot', 'wind_up_initiated_at',
    'wind_up_initiated_by', 'wind_up_finalised_at', 'lat', 'lng', 'location_auth_signer', 'auth_signer',
    'location_updated_at',
] as const;

export const TABLES: Record<string, TableEntry> = {
    // ── What a standby copies (engine sync.ts exportSyncState → engine/sync.ts importRemoteState) ──
    members: {
        kind: 'replicated-except', payload: 'members', watermark: 'updated_at',
        columns: cols('public_key callsign contact_value contact_visibility status updated_at moderation_muted_until area_lat area_lng area_updated_at is_visitor deleted_by_owner_at board_standing_changed_at'),
        except: {
            avatar_url: { reason: `${EMPTY_COPIED_AS_NULL} (an enterprise made with no photo holds '')`, gap: 'G2a' },
            bio: { reason: `${EMPTY_COPIED_AS_NULL} (a member who clears their bio saves '')`, gap: 'G2a' },
            archetype: { reason: `${EMPTY_COPIED_AS_NULL} (a profile saved with an empty archetype holds '')`, gap: 'G2a' },
            last_active_at: { reason: 'travels only with another change of the row, by design: it moves on every signed request and is not in the touch trigger' },
            ...Object.fromEntries(MEMBERS_STANDING_NOT_COPIED.map((c) => [c, { reason: 'not in the import (a member\'s and an enterprise\'s standing)', gap: 'G2a' as const }])),
            joined_at: { reason: 'written on the first copy only: a later change on the main server never reaches the standby', gap: 'G2a' },
            invited_by: { reason: 'written on the first copy only (and on a visitor\'s join)', gap: 'G2a' },
            invite_code: { reason: 'written on the first copy only (and on a visitor\'s join)', gap: 'G2a' },
            home_node_url: { reason: 'written on the first copy only', gap: 'G2a' },
            elder_vouched_by: { reason: 'the import keeps the first voucher it copied (COALESCE): a withdrawn vouch, a prune or a new voucher never reaches the standby', gap: 'G2a' },
        },
    },
    // A listing, its photos, a deal and a crowdfund project are the main server's rows verbatim, stamps included: the
    // import sets the tables' touch triggers aside while it writes them (engine/sync.ts IMPORT_KEEPS_STAMPS, G1, G1b).
    // `search_keywords` is the main server's too; one it holds empty (a linked community's listing it cached) is filled
    // by each server's boot backfill alike, from the same words (state-engine.ts backfillSearchKeywords).
    posts: {
        kind: 'replicated-except', payload: 'posts', watermark: 'updated_at',
        columns: cols('id type category title description credits author_pubkey created_at active status price_type repeatable accepted_by accepted_at pending_transaction_id completed_at lat lng origin_node updated_at search_keywords cash_also_needed reach reach_peers created_by poll_options poll_closes_at audience_scope target_group_id target_pubkey assigned_to event_start_at event_end_at event_place_name event_private_note event_state hidden_by_reports_at removed_by_moderator_at'),
        except: {
            target_archetypes: { reason: 'dormant: nothing reads or writes it (db.ts; archetypes gate nothing)' },
            event_conversation_id: { reason: 'dormant: nothing reads or writes it (only db.ts adds the column)' },
        },
    },
    // A photo taken off a listing travels as a `post_photos` tombstone (engine/posts.ts updatePost), judged against the
    // main server's stamp.
    post_photos: {
        kind: 'replicated-except', payload: 'photos', watermark: 'updated_at',
        columns: cols('post_id order_num updated_at'),
        except: {
            photo_data: { reason: 'how this server holds the bytes: inline until its image store has them (the payload carries the bytes)' },
            storage_key: { reason: "this server's image store object" },
            sha256: { reason: "this server's image store object" },
            bytes: { reason: "this server's image store object" },
            mime: { reason: "this server's image store object" },
        },
    },
    // The legacy crowdfund row, still live: a bounded enterprise writes one and its pledges count into it
    // (routes/treasury.ts, db.ts pledgeToProject).
    projects: {
        kind: 'replicated', payload: 'projects', watermark: 'updated_at',
        columns: cols('id creator_pubkey title description photos goal_amount current_amount deadline_at status migrated_at enterprise_pubkey created_at updated_at'),
    },
    ratings: {
        kind: 'replicated-except', payload: 'ratings', watermark: 'created_at',
        columns: cols('id target_pubkey rater_pubkey role stars transaction_id created_at'),
        except: {
            comment: { reason: "a rating with no comment is '' on the main server (the route stores `comment || ''`, the export sends `|| ''`) and null on the standby (the import writes `rt.comment || null`) (not in the design; found by this net)", gap: 'G1b' },
        },
    },
    // The main server's account set exactly, in every payload: each row as it holds it, and no other (engine/sync.ts
    // importRemoteState, G0). The Commons row's stamp is every server's own boot (BOOT_STAMPED).
    accounts: {
        kind: 'replicated', payload: 'accounts', watermark: WHOLE_SET,
        columns: cols('public_key balance last_updated_at last_demurrage_epoch'),
    },
    transactions: {
        kind: 'replicated', payload: 'transactions', watermark: 'timestamp',
        columns: cols('id from_pubkey to_pubkey amount tax_fee memo timestamp auth_signer auth_signature auth_payload project_id'),
        clearedByTombstone: {
            project_id: { tombstone: 'projects', reason: "a crowdfund project's delete stops its trades naming it (db.ts deleteCrowdfundProject)" },
        },
    },
    marketplace_transactions: {
        kind: 'replicated', payload: 'marketplaceTransactions', watermark: 'updated_at',
        columns: cols('id post_id buyer_pubkey seller_pubkey credits hours status created_at completed_at updated_at last_reminded_at dispute_resolution dispute_resolved_at dispute_resolved_by'),
    },
    friends: {
        kind: 'replicated-except', payload: 'friends', watermark: 'updated_at',
        columns: cols('owner_pubkey friend_pubkey added_at'),
        except: { updated_at: { reason: STAMPED_BY_STANDBY + ' (not in the design; found by this manifest)', gap: 'G1b' } },
    },
    conversations: {
        kind: 'replicated-except', payload: 'conversations', watermark: 'created_at',
        columns: cols('id type post_id created_by created_at'),
        except: {
            name: { reason: "a group rename writes it with no stamp (state-engine.ts updateGroup) and a delta picks conversations by created_at, so a new name arrives only in a whole copy (not in the design; found by this net)", gap: 'G1b' },
        },
    },
    conversation_participants: {
        kind: 'replicated', payload: 'conversationParticipants', watermark: 'updated_at',
        columns: cols('conversation_id public_key last_read_at updated_at'),
    },
    messages: {
        kind: 'replicated-except', payload: 'messages', watermark: 'updated_at',
        columns: cols('id conversation_id author_pubkey ciphertext nonce type system_type timestamp edited_at updated_at'),
        except: {
            metadata: { reason: "the send route stores a request's metadata as given, so '' is '' on the main server and null on the standby (the export sends `|| undefined`, the import writes `|| null`); neither app sends '' (not in the design; found by this net)", gap: 'G1b' },
        },
    },
    abuse_reports: {
        kind: 'replicated', payload: 'abuseReports', watermark: 'updated_at',
        columns: cols('id reporter_pubkey target_pubkey target_post_id target_pulse_item_id reason status created_at updated_at'),
    },
    creator_channels: {
        kind: 'replicated-except', payload: 'creatorChannels', watermark: 'updated_at',
        columns: cols('id owner_pubkey platform url handle category is_primary_video supports_autolist oauth_verified_at post_count_seen autopublish syndicate_to_node created_at updated_at deleted_at'),
        except: {
            fail_count: { reason: "the harvester's own record of failed fetches on this server; a promoted server's harvester starts afresh" },
            last_error: { reason: "the harvester's own record of failed fetches on this server" },
            is_stale: { reason: "the harvester's own record of failed fetches on this server" },
        },
    },
    pulse_items: {
        kind: 'replicated', payload: 'pulseItems', watermark: 'updated_at',
        columns: cols('id channel_id owner_pubkey platform external_id url title thumbnail_url published_at category source muted curated created_at updated_at deleted_at'),
    },
    recovery_shares: {
        kind: 'replicated-except', payload: 'recoveryShares', watermark: 'updated_at',
        columns: cols('owner_pubkey holder_type holder_ref share_index encrypted_share share_iv share_tag ephemeral_pubkey sso_lookup_hash sso_lookup_salt kdf_params generation created_at updated_at'),
        key: ['owner_pubkey', 'generation', 'holder_type', 'holder_ref'],
        except: { id: { reason: 'a local row id: rows are matched by owner, generation and holder' } },
    },
    settlements: {
        kind: 'replicated', payload: 'settlements', watermark: 'updated_at',
        columns: cols('key direction peer_id buyer_pubkey buyer_home_node seller_pubkey post_id amount fee reserved_until state receipt receipt_payload failure_reason created_at updated_at'),
    },
    poll_votes: {
        kind: 'replicated', payload: 'pollVotes', watermark: 'created_at',
        columns: cols('post_id voter_pubkey option_id signature created_at'),
    },
    event_rsvps: {
        kind: 'replicated', payload: 'eventRsvps', watermark: 'updated_at',
        columns: cols('post_id member_pubkey status signature reminder_offsets updated_at'),
    },
    groups: {
        kind: 'replicated-except', payload: 'groups', watermark: 'updated_at',
        columns: cols('id name slug description avatar_url category created_by join_policy created_at updated_at'),
        except: {
            lead_pubkey: { reason: "the import keeps the lead it has over the main server's null (COALESCE): a group whose last convenor left has no lead there and keeps the old one on the standby (not in the design; found by this net)", gap: 'G1b' },
        },
    },
    group_members: {
        kind: 'replicated', payload: 'groupMembers', watermark: 'updated_at',
        columns: cols('group_id member_pubkey role status joined_at invited_by updated_at'),
    },
    open_joins: {
        kind: 'replicated-except', payload: 'openJoins', watermark: 'updated_at',
        columns: cols('member_pubkey provider join_hash joined_at updated_at'),
        except: { ip_hash: { reason: 'the address hash is never sent (engine/open-join.ts)' } },
    },
    place_watches: {
        kind: 'replicated', payload: 'placeWatches', watermark: 'updated_at',
        columns: cols('id pubkey lat lng radius_km created_at last_notified_at updated_at'),
    },
    directory_cache: {
        kind: 'replicated', payload: 'directoryCache', watermark: 'updated_at',
        columns: cols('community_key listed name node_url lat lng radius_km member_count contact_email contact_phone registry_updated_at first_seen_at updated_at'),
    },
    join_requests: {
        kind: 'replicated-except', payload: 'joinRequests', watermark: 'updated_at',
        columns: cols('id pubkey callsign message avatar from_node status created_at decided_by invite_code decided_at updated_at'),
        except: { ip_hash: { reason: "the knock limiter's, for a day; never sent (engine/knocks.ts)" } },
    },
    moderation_notices: {
        kind: 'replicated', payload: 'moderationNotices', watermark: 'updated_at',
        columns: cols('id recipient title body data created_at seen_at updated_at'),
    },
    member_blocks: {
        kind: 'replicated', payload: 'memberBlocks', watermark: 'updated_at',
        columns: cols('owner_pubkey blocked_pubkey created_at updated_at'),
    },
    invalidated_keys: {
        kind: 'replicated', payload: 'invalidatedKeys', watermark: 'invalidated_at',
        columns: cols('public_key reason invalidated_at rekeyed_to'),
    },
    tombstones: {
        kind: 'replicated', payload: 'tombstones', watermark: 'deleted_at',
        columns: cols('table_name row_key deleted_at'),
    },

    // ── Carried by the take-over bundle ──
    node_roles: { kind: 'takeover-bundle', reason: 'the raw table is sealed in the bundle; the take-over\'s `roles` step writes it' },
    node_config: {
        kind: 'takeover-bundle', bySetting: true,
        reason: 'a key-value store: parts travel in the sync payload, parts in the bundle, the rest is per server or lost today; each key is classified in NODE_CONFIG_KEYS',
    },

    // ── Not copied today, and the design says they should be ──
    member_preferences: { kind: 'local', gap: 'G2b', reason: 'not in the payload: holiday, notification opt-outs, reminder defaults' },
    treasury_operators: { kind: 'local', gap: 'G2c', reason: 'not in the payload: who keeps each enterprise' },
    enterprise_pledges: { kind: 'local', gap: 'G2c', reason: "not in the payload: keepers' pledges" },
    deferred_wage_claims: { kind: 'local', gap: 'G3', reason: "not in the payload: keepers' unpaid wages" },
    decisions: { kind: 'local', gap: 'G3', reason: 'not in the payload' },
    decision_votes: { kind: 'local', gap: 'G3', reason: 'not in the payload' },
    suspended_node_roles: { kind: 'local', gap: 'G3', reason: 'not in the payload nor the bundle: an owner parked by a Decision' },
    enterprise_keeper_requests: { kind: 'local', gap: 'G3', reason: 'not in the payload' },
    enterprise_keeper_changes: { kind: 'local', gap: 'G3', reason: 'not in the payload' },
    enterprise_succession_proposals: { kind: 'local', gap: 'G3', reason: 'not in the payload' },
    enterprise_succession_votes: { kind: 'local', gap: 'G3', reason: 'not in the payload' },
    group_convenor_proposals: { kind: 'local', gap: 'G3', reason: 'not in the payload' },
    group_convenor_votes: { kind: 'local', gap: 'G3', reason: 'not in the payload' },
    invite_codes: { kind: 'local', gap: 'G3', reason: 'not in the payload: every invite already sent fails after a take-over' },
    rekey_requests: { kind: 'local', gap: 'G3', reason: 'not in the payload: an unused re-key code is refused after a take-over' },
    recovery_releases: { kind: 'local', gap: 'G3', reason: 'not in the payload: the log of which recovery fragments left the node' },
    federation_links: { kind: 'local', gap: 'G3', reason: 'not in the payload: a promoted server would make a second link treasury per peer' },
    push_tokens: { kind: 'local', gap: 'G4', reason: "not in the payload: no push reaches anyone until their phone reopens the app" },
    message_attachments: { kind: 'local', gap: 'G4', reason: 'not in the payload: chat photos (they need the image-store path post_photos has)' },
    chat_mutes: { kind: 'local', gap: 'G4', reason: 'not in the payload' },
    thread_read_cursors: { kind: 'local', gap: 'G4', reason: 'not in the payload' },
    event_reminders_sent: { kind: 'local', gap: 'G4', reason: 'not in the payload: a reminder can be sent twice' },
    activity_feed: { kind: 'local', gap: 'G4', reason: 'not in the payload' },
    pricing_guide_items: { kind: 'local', gap: 'G4', reason: "not in the payload: each server seeds its own at boot, and the admin's edits are lost" },
    pricing_reports: { kind: 'local', gap: 'G4', reason: "not in the payload: members' price reports" },

    // ── Local by design ──
    sync_cursors: { kind: 'local', reason: "this server's own pull cursors" },
    push_token_leaves: {
        kind: 'local',
        reason: "a day's record of leave statements applied here, only for a registration delivered late; the fix for G4 carries it with push_tokens",
    },
    sync_audit_log: { kind: 'local', reason: "this server's own record of what it imported" },
    system_logs: { kind: 'local', reason: "this server's logs" },
    system_metrics: { kind: 'local', reason: "this server's metrics" },
    signature_audiences: { kind: 'local', reason: 'counts of which addresses signatures named, shown and never deciding' },
    onboarding_funnel: { kind: 'local', reason: "this server's funnel counters" },
    pulse_thumbnail_backoff: { kind: 'local', reason: "this server's thumbnail fetch backoff" },
    owner_words_checks: { kind: 'local', reason: 'shown, never deciding' },
    owner_lock_opens: { kind: 'local', reason: 'shown, never deciding' },
    rekey_audit_log: { kind: 'local', reason: "this server's audit trail of re-keys it performed" },
    recovery_collections: { kind: 'local', reason: 'a 72-hour recovery session; the member starts again' },
    invite_links: { kind: 'local', reason: 'nothing reads or writes it (the design: delete it, day zero)' },
    posts_fts: { kind: 'local', reason: 'the search index, rebuilt from posts by its triggers on each server' },
};

/**
 * Rows a server writes again at every boot of its own, stamped with its own clock: system-managed rows whose canonical
 * values always win (engine/pulse-seed.ts seedPulseCurated). Two servers stamp them at their own boots, so the stamp is
 * never compared; everything else in the row is.
 */
export const BOOT_STAMPED: { table: string; column: string; where: string; reason: string }[] = [
    { table: 'creator_channels', column: 'updated_at', where: "id = 'chan_beanpool_learn'", reason: "the BeanPool learn channel, re-seeded at every boot" },
    { table: 'pulse_items', column: 'updated_at', where: 'curated = 1', reason: 'the curated learn items, re-seeded at every boot' },
    {
        table: 'accounts', column: 'last_updated_at', where: "public_key = 'COMMONS_POOL'",
        reason: "the Commons row, which every server writes again from the pot it holds, at each boot's ledger audit and every five minutes (engine/audit.ts persistCommonsBalance)",
    },
];

/** SQLite's own tables and a virtual table's shadow tables belong to no decision here. */
export function isInternalTable(name: string, type: string): boolean {
    return name.startsWith('sqlite_') || type === 'shadow';
}

/**
 * members columns the touch trigger (`members_touch_updated_at`, schema.sql) does not list, and why. Every other
 * column moves `updated_at` when it changes, so a delta carries the change.
 */
export const MEMBERS_NOT_TOUCHING: Record<string, ColumnException> = {
    updated_at: { reason: 'the stamp itself' },
    last_active_at: { reason: 'travels only with another change of the row, by design' },
    board_standing_changed_at: { reason: 'every change of standing moves updated_at in the same statement (paused and status are in the trigger; setHolidayMode stamps both), so a delta carries it; listed, the trigger would restamp a copied row' },
    earned_surplus: { reason: 'missing from the trigger: a change to it alone never moves updated_at', gap: 'G2a' },
    working_capital_ceiling: { reason: 'missing from the trigger: a change to it alone never moves updated_at', gap: 'G2a' },
};

// ── Community settings (design §2 G5) ──────────────────────────────────────────────────────

export type SettingEntry =
    /** In every sync payload, signed (engine/sync.ts exportSyncState). */
    | { kind: 'payload'; reason: string; differsByDesign?: string }
    /** In the take-over bundle (services/takeover-envelope.ts). */
    | { kind: 'takeover-bundle'; reason: string; differsByDesign?: string }
    /**
     * The community's own: in every sync payload's signed `communitySettings` record (config/community-settings.ts). A
     * standby keeps the record and applies none of it; a take-over, or a hand promotion, installs it.
     */
    | { kind: 'community-settings'; reason: string }
    /** The community's, and lost on a take-over today. */
    | { kind: 'community'; reason: string; gap: GapId }
    /** This server's own, and stays with it. */
    | { kind: 'per-server'; reason: string };

/** Every field of local-config.json (config/local-config.ts LocalConfig). */
export const LOCAL_CONFIG_FIELDS: Record<string, SettingEntry> = {
    callsign: { kind: 'community-settings', reason: "the community's short name, in every app and the directory" },
    communityName: { kind: 'community-settings', reason: "the community's name" },
    location: { kind: 'community-settings', reason: "the community's place" },
    contactEmail: { kind: 'community-settings', reason: "the community's contact, sent to the directory" },
    contactPhone: { kind: 'community-settings', reason: "the community's contact, sent to the directory" },
    currencyType: { kind: 'community-settings', reason: "the currency's display" },
    currencyValue: { kind: 'community-settings', reason: "the currency's display" },
    thresholds: { kind: 'community-settings', reason: 'demurrage rate and epoch, health flags' },
    gateway: {
        kind: 'community-settings',
        reason: "the web app's other origins, the subsystem switches and the request limit; not the admin IP allowlist in it, which "
            + "names addresses on one server's own network, stays with each server and is never in the record",
    },
    adminHash: { kind: 'takeover-bundle', reason: "the community's admin password" },
    salt: { kind: 'takeover-bundle', reason: "the community's admin password" },
    totpEnabled: { kind: 'takeover-bundle', reason: 'two-factor sign-in' },
    totpSecret: { kind: 'takeover-bundle', reason: 'two-factor sign-in' },
    totpBackupCodesHashes: { kind: 'takeover-bundle', reason: 'two-factor sign-in' },
    breakGlassMode: { kind: 'takeover-bundle', reason: 'break-glass sign-in' },
    recoveryCode: { kind: 'takeover-bundle', reason: "the public record of the community's recovery code" },
    identityEpoch: { kind: 'takeover-bundle', reason: 'how many take-overs this identity has been through', differsByDesign: 'a take-over writes the bundle\'s epoch + 1' },
    isLocked: { kind: 'per-server', reason: "whether this server's admin password has been set" },
    joinedAt: { kind: 'per-server', reason: "when this server's admin password was set" },
    totpPendingSecret: { kind: 'per-server', reason: 'a two-factor enrolment in progress on this server' },
    totpPendingBackupCodesHashes: { kind: 'per-server', reason: 'a two-factor enrolment in progress on this server' },
    backupPrimaryUrl: { kind: 'per-server', reason: "a standby's main server" },
    backupAdminPassword: { kind: 'per-server', reason: "a standby's legacy pull password" },
    replicationTokenHash: { kind: 'per-server', reason: "the token this server's standbys pull with; never in the bundle" },
    replicationTokenSalt: { kind: 'per-server', reason: "the token this server's standbys pull with" },
    replicationTokenCreatedAt: { kind: 'per-server', reason: "the token this server's standbys pull with" },
    replicationTokenOnly: { kind: 'per-server', reason: "the token this server's standbys pull with" },
    backupReplicationToken: { kind: 'per-server', reason: "a standby's token for its main server" },
    backupPullSeconds: { kind: 'per-server', reason: "a standby's pull interval" },
    backupReconcileMinutes: { kind: 'per-server', reason: "a standby's whole-copy interval" },
    recoveryCodeLastId: { kind: 'per-server', reason: 'the last recovery code number this server made' },
    nodeRole: { kind: 'per-server', reason: "this server's role" },
    promotionAuditPending: { kind: 'per-server', reason: "this server's take-over audit" },
    lastPromotionAudit: { kind: 'per-server', reason: "this server's take-over audit" },
    recoveryCodeUsed: { kind: 'per-server', reason: 'the notice that a take-over spent the code, on the server it ran on' },
    identityEpochSince: { kind: 'per-server', reason: 'when this server took the identity' },
    identityReplaced: { kind: 'per-server', reason: 'this server noticed another took its identity' },
};

/**
 * node_config rows, by key (exact) or by prefix (`*` at the end). The `node_config` row itself is a JSON object whose
 * fields are classified in NODE_CONFIG_BLOB_FIELDS.
 */
export const NODE_CONFIG_KEYS: Record<string, SettingEntry> = {
    node_config: { kind: 'per-server', reason: 'a JSON object; each field is classified in NODE_CONFIG_BLOB_FIELDS' },
    nodeProfile: { kind: 'payload', reason: 'the node profile record (payload.nodeProfile)' },
    'nodeProfile.*': { kind: 'payload', reason: "the operator's switch overrides (payload.nodeProfile)" },
    openJoinSalt: { kind: 'payload', reason: "the key the open door's hashes are made with (payload.openJoinSalt)" },
    migration_mark_visitors_v1: {
        kind: 'payload', reason: "whether visitors' rows are marked (payload.visitorsMarked)",
        differsByDesign: "a standby records 'copied': the marks in its copy are its main server's (db.ts noteVisitorsMarkedByMainServer)",
    },
    recovery_seal_main_epoch: { kind: 'payload', reason: "the recovery seal's epoch (payload.sealEpoch)" },
    ledger_audit_baseline: { kind: 'community-settings', reason: "the accepted ledger audit baseline, which the promotion audit holds the ledger to; in the record only where the main server has one" },
    ledger_audit_rebaseline_note: { kind: 'community-settings', reason: 'why the baseline was accepted' },
    pricing_data_source: { kind: 'community-settings', reason: "the pricing guide's source" },
    pricing_show_seasonality: { kind: 'community-settings', reason: "the pricing guide's seasonality display" },
    autosnapshot_config: { kind: 'community-settings', reason: 'the snapshot schedule' },
    commons_projects: {
        kind: 'community', gap: 'G3',
        reason: 'pending Commons proposals kept as one JSON value; still written (POST /api/commons/projects, state-engine.ts createProject), '
            + 'so in-flight governance, not a setting',
    },
    avatarKeySecret: { kind: 'per-server', reason: "the key behind members' avatar URLs, made at boot (engine/avatar-keys.ts)" },
    appAddressStaffSeen: { kind: 'per-server', reason: 'which app addresses staff have seen signatures name' },
    directoryMirror: { kind: 'per-server', reason: "this server's directory mirror status" },
    takeover_envelope_holders: { kind: 'per-server', reason: 'which standbys hold this server\'s take-over envelope' },
    replication_access: { kind: 'per-server', reason: "this server's replication access log" },
    replicated_member_blocks_v1: { kind: 'per-server', reason: "a standby's own marker" },
    replica_format: { kind: 'per-server', reason: "the importer format a standby's copy was made with (engine/sync.ts REPLICA_FORMAT)" },
    replica_main_ledger: { kind: 'per-server', reason: "a standby's record of its main server's ledger at its last copy, which a take-over's audit holds it to" },
    replica_ledger_mismatch: { kind: 'per-server', reason: "a standby's last whole copy whose ledger wasn't its main server's (services/backup-puller.ts)" },
    replica_community_settings: { kind: 'per-server', reason: "a standby's kept copy of its main server's community settings, until a take-over or a hand promotion installs it (config/community-settings.ts)" },
    replica_held_sum: { kind: 'per-server', reason: "the total a standby's next copy is held to after it cleared its ledger for a force-resync that isn't a seed (engine/sync.ts clearForResync)" },
    replicated_invalidated_keys_v1: { kind: 'per-server', reason: "a standby's own marker" },
    recovery_seal_cleared: { kind: 'per-server', reason: "this server's record of clearing its database after sealing" },
    recovery_seal_reopened: { kind: 'per-server', reason: "this server's record of reopening its seal" },
    image_store_evacuation_vacuumed_v1: { kind: 'per-server', reason: 'a one-shot marker of this server' },
    'migration_*': { kind: 'per-server', reason: "one-shot boot markers of this server's own database" },
};

/** Fields of the `node_config` row's JSON object (state-engine.ts NodeConfig). */
export const NODE_CONFIG_BLOB_FIELDS: Record<string, SettingEntry> = {
    serviceRadius: { kind: 'community-settings', reason: "the community's service area: the map, the Market, the directory" },
    publishLocation: { kind: 'community-settings', reason: 'a directory switch; unset reads as publish' },
    publishMembers: { kind: 'community-settings', reason: 'a directory switch; unset reads as publish' },
    publishContacts: { kind: 'community-settings', reason: 'a directory switch; unset reads as publish' },
    publishHealth: { kind: 'community-settings', reason: 'a directory switch; unset reads as publish' },
    directoryPushIntervalHours: { kind: 'community-settings', reason: 'how often the directory is told' },
    lastDirectoryPush: { kind: 'per-server', reason: 'when this server last told the directory' },
    publicAddress: { kind: 'takeover-bundle', reason: 'the web address, with its tunnel token' },
    ownerAddresses: { kind: 'takeover-bundle', reason: 'app addresses an owner confirmed' },
    registrarNames: { kind: 'takeover-bundle', reason: 'every registrar name this key held' },
};

/** The entry for a node_config key, exact match first, then the longest prefix. */
export function nodeConfigKeyEntry(key: string): SettingEntry | undefined {
    if (NODE_CONFIG_KEYS[key]) return NODE_CONFIG_KEYS[key];
    let best: { len: number; entry: SettingEntry } | undefined;
    for (const [k, entry] of Object.entries(NODE_CONFIG_KEYS)) {
        if (!k.endsWith('*')) continue;
        const prefix = k.slice(0, -1);
        if (key.startsWith(prefix) && (!best || prefix.length > best.len)) best = { len: prefix.length, entry };
    }
    return best?.entry;
}

/** Whether a setting is one a promoted standby must hold as its main server did (compared by the twin suite). */
export function settingMustMatch(entry: SettingEntry): boolean {
    if (entry.kind === 'community' || entry.kind === 'community-settings') return true;
    return (entry.kind === 'payload' || entry.kind === 'takeover-bundle') && !entry.differsByDesign;
}

/**
 * The columns of `table` the twin suite compares, given its columns as they are: every column a replicated table
 * copies, every one the design says should be copied (a `gap`), and the rows the take-over bundle brings. Columns
 * local by design are left out. Null for a table the twin suite doesn't compare as rows (local by design, or
 * classified key by key).
 */
export function comparedColumns(table: string, columns: string[]): string[] | null {
    const entry = TABLES[table];
    if (!entry) return null;
    if (entry.kind === 'takeover-bundle') return entry.bySetting ? null : columns;
    if (entry.kind === 'local' && !entry.gap) return null;
    const except = 'except' in entry ? entry.except ?? {} : {};
    return columns.filter((c) => !except[c] || !!except[c].gap);
}
