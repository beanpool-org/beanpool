import crypto from 'node:crypto';
import { LedgerManager, COMMONS_BALANCE, setCommonsBalance, getTier, getGenesisEarnedCredit, vouchCreditForLevel, grantedCreditForTier, offerCapForCount, offersRequiredForDepth, OFFER_BANDS, PROTOCOL_CONSTANTS, TRANSACTION_FEE_RATE, isSyntheticAccount, isEscrowAccount, ESCROW_FLOOR, SYNONYM_MAP } from '@beanpool/core';
import type { TrustStats, TierInfo, GenesisInviteType, VouchLevel, TierName, AudienceScope } from '@beanpool/core';
export type { EscrowRefundShortfall };
import * as engine from '@beanpool/engine';
import type { WashAnalysis } from '@beanpool/engine';
export type { WashAnalysis };
import { getThresholds, getLocalConfig } from './config/local-config.js';
import {
    getNodeProfile, getNodeFeatures, getProfileSwitches, mirrorNodeProfileAtBoot, assertBeansOn, forgetLedgerHistory,
    BeansOffError, BEANS_OFF_PRICE_MESSAGE, type NodeProfile, type NodeFeatures,
} from './config/node-profile.js';
import { installAvatarKeysAtBoot } from './engine/avatar-keys.js';
import { installRecoverySealAtBoot, clearCopiesDroppedBeforeSeal } from './services/recovery-seal-key.js';
import { getVersion } from './version.js';
import { getAppStoreVersions, getMinAppVersion, type AppStoreVersions } from './app-store-versions.js';
import { db, initSchema, migrateLegacyState, writeTombstone, setBalanceMutationHook, setDemurrageSettleHook, setMoneyGuardHook, afterTransactionCommit, isOperatorSwitchedOff, OPERATOR_SWITCHED_OFF_CREATE_ERROR, INACTIVE_MEMBER_CREATE_ERROR, raiseCreatorOperatorSwitch } from './db/db.js';
import { registerBridgeDecayExemptions, ensureBridgeAccount } from './federation-bridge.js';
import { peerFromBridgeAccountId } from '@beanpool/core';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPrivateKey } from './p2p.js';
import { publicKeyToProtobuf, publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { ledger } from './engine/ledger.js';
import { pruneFunnel } from './engine/funnel.js';
import { releaseOpenJoin } from './engine/open-join.js';
import { isAcceptableAvatarValue, isAcceptablePhotoValue, AVATAR_FORMAT_ERROR } from './engine/avatar.js';
import { stripImageValue } from './storage/image-metadata.js';
import { pruneOldActivity } from './db/activity-feed-db.js';
import { scrubChannelRows } from './engine/creator-channels.js';
import { getUnhandledRejectionSummary } from './process-handlers.js';
import { scrubPulseItems } from './engine/pulse-resolver.js';
import { adminActorName } from './engine/admin-actor-name.js';
import { closeOpenReportsOnPost, notifyPostTakedown, notifyPostsCleared, notifyReportDismissed, normaliseRemovalReason } from './engine/moderation-notices.js';
import { dropPlaceWatches } from './engine/place-watches.js';
import { scrubKnocksOf } from './engine/knocks.js';
import { dropKeptNoticesOf, tidyKeptNotices } from './engine/kept-notices.js';
import { deleteAllShares, applyRecordedRecoveryTombstones } from './engine/recovery-shares.js';
import { forgetListedCommunities } from './engine/directory-cache.js';
import {
    evaluateAutoHide, recheckHiddenPost, restoreHiddenPost as restoreHiddenPostEngine, recordModeratorRemoval,
    evaluateAutoMute, liftMute as liftMuteEngine,
} from './engine/auto-moderation.js';
import { seedPulseCurated } from './engine/pulse-seed.js';
import {
    nodeRoleOf,
    heldNodeRoleOf,
    isNodeOwner,
    isNodeAdmin,
    getFirstNodeAdminPubkey,
    listNodeRoles,
    grantNodeRole,
    revokeNodeRole,
    getNodeRoleSessionEpoch,
    bumpNodeRoleSessionEpoch,
    setNodeRoleBreakGlassHash,
    getNodeRoleBreakGlassHash,
    NODE_ROLE_ACTS,
    type MemberNodeRole,
    type NodeRoleRecord,
} from './engine/node-roles.js';
export {
    nodeRoleOf,
    heldNodeRoleOf,
    isNodeOwner,
    isNodeAdmin,
    getFirstNodeAdminPubkey,
    listNodeRoles,
    grantNodeRole,
    revokeNodeRole,
    getNodeRoleSessionEpoch,
    bumpNodeRoleSessionEpoch,
    setNodeRoleBreakGlassHash,
    getNodeRoleBreakGlassHash,
    type MemberNodeRole,
    type NodeRoleRecord,
};
import {
    createDecision,
    getDecision,
    publicDecision,
    getAllDecisions,
    getOpenDecisions,
    castDecisionVote,
    getDecisionVotes,
    tallyDecision,
    executeDecision,
    tickDecisions,
    adminHaltDecision,
    adminAccelerateDecision,
    getActiveMembersCount30d,
    getQuorumRequired,
    checkCanProposeDecision,
    checkProposalStanding,
    checkVoterEligibility,
    getDecisionVoiceCredits,
    getOwnDecisionVotes,
    getVoiceCredits,
    hasCompletedTrade,
    getDecisionElectorate,
    adminEmergencySuspend,
    adminLiftSuspension,
    isAdminActor,
    type Decision,
    type DecisionVote,
    type DecisionTally,
    type DecisionTouch,
    type DecisionEffect,
    type DecisionFranchise,
    type DecisionStatus,
    type CreateDecisionOptions,
} from './decisions-engine.js';
export {
    createDecision,
    getDecision,
    publicDecision,
    getAllDecisions,
    getOpenDecisions,
    castDecisionVote,
    getDecisionVotes,
    tallyDecision,
    executeDecision,
    tickDecisions,
    adminHaltDecision,
    adminAccelerateDecision,
    getActiveMembersCount30d,
    getQuorumRequired,
    checkCanProposeDecision,
    checkProposalStanding,
    checkVoterEligibility,
    getDecisionVoiceCredits,
    getOwnDecisionVotes,
    getVoiceCredits,
    hasCompletedTrade,
    getDecisionElectorate,
    adminEmergencySuspend,
    adminLiftSuspension,
    isAdminActor,
    type Decision,
    type DecisionVote,
    type DecisionTally,
    type DecisionTouch,
    type DecisionEffect,
    type DecisionFranchise,
    type DecisionStatus,
    type CreateDecisionOptions,
};
import {
    persistCommonsBalance as persistCommonsBalanceEngine,
    runWashSybilMetricsAudit as runWashSybilMetricsEngine,
    getReplicaConsistency as getReplicaConsistencyEngine,
    exportLedgerAudit as exportLedgerAuditEngine,
    persistDecayEvents as persistDecayEventsEngine,
    persistDecayAndCommons as persistDecayAndCommonsEngine,
    runLedgerAudit as runLedgerAuditEngine,
    promotionSanityCheck as promotionSanityCheckEngine,
    type ReplicaConsistency
} from './engine/audit.js';
import {
    recordActivity,
    seedGenesisMember,
    registerMember as registerMemberEngine,
    registerVisitor,
    writeVisitorRow,
    updateProfile as updateProfileEngine,
    isCallsignAvailable,
    findRecoveryCandidates,
    setMemberActivityHook,
    NOT_A_MEMBER_ERROR,
    NOT_A_MEMBER_CODE,
    assertNodeMember,
} from './engine/members.js';
import { isMemberKeySpelling, badKeyError, reportMisspeltMemberKeys } from './engine/member-key.js';
import { ticketBinding } from './engine/member-signature.js';
import {
    generateInvite,
    adminGenerateInvite,
    redeemInvite as redeemInviteEngine,
    redeemOfflineTicket as redeemOfflineTicketEngine
} from './engine/invites.js';
import { avatarUrlFor, isServableAvatarValue } from '@beanpool/core';
import {
    getMember as getMemberEngine,
    getMembers as getMembersEngine,
    getAllMembers as getAllMembersEngine,
    checkInvite as checkInviteEngine,
    getInvitesByMember as getInvitesByMemberEngine,
    getInviteTree as getInviteTreeEngine,
    getProfile as getProfileEngine,
    getAllProfiles as getAllProfilesEngine,
    contactVisibleTo,
    contactViewer as contactViewerEngine,
    isNodeMember as isNodeMemberEngine,
    readsAsMember as readsAsMemberEngine,
    passesReadGate as passesReadGateEngine,
    isVisitorKey as isVisitorKeyEngine,
    isLiveVisitor as isLiveVisitorEngine,
    mayBringSomeoneIn as mayBringSomeoneInEngine,
    alreadyJoined as alreadyJoinedEngine,
    isInvalidatedKey as isInvalidatedKeyEngine,
    publicMemberCard,
    type ContactViewer,
    rowToMember,
    rowToProfile,
    type Member,
    type InviteCode,
    type MemberProfile,
    type InviteCheckResult,
    type InviteTreeNode,
    getRatings as getRatingsEngine,
    getRatingsGiven as getRatingsGivenEngine,
    getAverageRating as getAverageRatingEngine,
    getFriends as getFriendsEngine,
    type Rating,
    type FriendEntry,
    getPosts as getPostsEngine,
    withoutPollVoters,
    getPostCount as getPostCountEngine,
    getActivePostCount as getActivePostCountEngine,
    hasListedOffer as hasListedOfferEngine,
    hasLiveOffer as hasLiveOfferEngine,
    liveOfferCount as liveOfferCountEngine,
    generateSearchKeywords as generateSearchKeywordsEngine,
    CONTRIBUTION_REQUIRED_ERROR,
    COVENANT_REQUIRED_ERROR,
    type MarketplacePost,
    type PostFilter,
    getMarketplaceTransaction as getMarketplaceTransactionEngine,
    getMarketplaceTransactions as getMarketplaceTransactionsEngine,
    type MarketplaceTransaction,
    SystemMessageType,
    type SystemMessageTypeVal,
    type TypedMessagePayload,
    type Message,
    type Conversation,
    getConversationsByMember as getConversationsByMemberEngine,
    getConversationMessages as getConversationMessagesEngine,
    getConversation as getConversationEngine,
    getUnreadCounts as getUnreadCountsEngine,
    getStateHash as getStateHashEngine,
    exportSyncState as exportSyncStateEngine,
    type PostPhoto,
    type Project,
    type SyncAccount,
    type SyncFriend,
    type SyncConversationParticipant,
    type SyncConversation,
    type SyncAbuseReport,
    type SyncRecoveryRequest,
    type SyncRecoveryApproval,
    type SyncMarketplaceTransaction,
    type SyncPollVote,
    type SyncPayload,
    createGroup as createGroupEngine,
    getGroup as getGroupEngine,
    listGroups as listGroupsEngine,
    getGroupMembers as getGroupMembersEngine,
    getGroupMember as getGroupMemberEngine,
    isGroupConvenor as isGroupConvenorEngine,
    isGroupMember as isGroupMemberEngine,
    getGroupLead as getGroupLeadEngine,
    isGroupLead as isGroupLeadEngine,
    handOverGroupLead as handOverGroupLeadEngine,
    getMemberGroupIds as getMemberGroupIdsEngine,
    joinGroup as joinGroupEngine,
    setMemberRole as setMemberRoleEngine,
    removeGroupMember as removeGroupMemberEngine,
    updateGroupPolicy as updateGroupPolicyEngine,
    updateGroup as updateGroupEngine,
    approveGroupMember as approveGroupMemberEngine,
    inviteGroupMember as inviteGroupMemberEngine,
    deleteGroupPost as deleteGroupPostEngine,
    type Group,
    type GroupMember,
    type GroupRole,
    type JoinPolicy,
    type GroupCategory,
    type GroupMemberStatus,
    type CreateGroupParams,
    type UpdateGroupParams,
    type ListGroupsFilter
} from '@beanpool/engine';
import {
    addRating,
    addFriend,
    removeFriend
} from './engine/social.js';
import {
    createPost as createPostEngine,
    removePost as removePostEngine,
    updatePost as updatePostEngine,
    pausePost as pausePostEngine,
    resumePost as resumePostEngine,
    closePoll as closePollEngine,
    votePoll as votePollEngine,
    rsvpEvent as rsvpEventEngine,
    adminDeletePost as adminDeletePostEngine,
    type EscrowRefundShortfall
} from './engine/posts.js';
import {
    requestPost as requestPostEngine,
    approvePostRequest as approvePostRequestEngine,
    rejectPostRequest as rejectPostRequestEngine,
    cancelPostRequest as cancelPostRequestEngine,
    acceptPost as acceptPostEngine,
    completePostTransaction as completePostTransactionEngine,
    cancelPostTransaction as cancelPostTransactionEngine,
    resolveEscrowDispute as resolveEscrowDisputeEngine,
    type EscrowDisputeAction
} from './engine/escrow.js';
import {
    createConversation as createConversationEngine,
    sendMessage as sendMessageEngine,
    toggleMessageReaction as toggleMessageReactionEngine,
    editMessage as editMessageEngine,
    deleteOwnMessage as deleteOwnMessageEngine,
    MESSAGE_EDIT_WINDOW_MS,
    injectSystemMessage as injectSystemMessageEngine,
    markConversationRead as markConversationReadEngine,
    ensureTransactionConversation as ensureTransactionConversationEngine,
    migrateConsolidateConversations as migrateConsolidateConversationsEngine,
    repairConsolidatedMessagesMetadata as repairConsolidatedMessagesMetadataEngine,
    removeOldChatGroups
} from './engine/messaging.js';
import {
    ensureGroupThread,
    backfillGroupThreads,
    syncGroupThreadMembership,
    postGroupSystemLine,
    callsignOf,
    getGroupThread as getGroupThreadEngine,
    postGroupThreadMessage as postGroupThreadMessageEngine,
    removeGroupThreadMessage as removeGroupThreadMessageEngine,
    GroupSystemType,
    type GroupThreadView,
} from './engine/group-thread.js';
export { GROUP_THREAD_NOTICE, GROUP_THREAD_MESSAGE_MAX, GroupSystemType, canReadGroupThread } from './engine/group-thread.js';
import {
    proposeGroupConvenor as proposeGroupConvenorEngine,
    voteGroupConvenor as voteGroupConvenorEngine,
    getGroupSuccession as getGroupSuccessionEngine,
    tickGroupSuccession as tickGroupSuccessionEngine,
    cancelGroupSuccessionIfConvenorActive,
} from './engine/group-succession.js';
export { GROUP_CONVENOR_SILENCE_MS, GROUP_SUCCESSION_WINDOW_MS } from './engine/group-succession.js';
import { listYourChats as listYourChatsEngine } from './engine/your-groups.js';
import {
    ensureEnterpriseThread as ensureEnterpriseThreadEngine,
    getEnterpriseThreadMessages as getEnterpriseThreadMessagesEngine,
    postEnterpriseThreadMessage as postEnterpriseThreadMessageEngine,
    removeEnterpriseThreadMessage as removeEnterpriseThreadMessageEngine,
    isKeeperOfEnterprise as isKeeperOfEnterpriseEngine,
    type EnterpriseThreadMessage
} from './engine/enterprise-thread.js';
export { isEnterpriseThreadHidden, isEnterpriseThreadReadOnly } from './engine/enterprise-thread.js';
import {
    getEventThread as getEventThreadEngine,
    postEventThreadMessage as postEventThreadMessageEngine,
    removeEventThreadMessage as removeEventThreadMessageEngine,
    chatHiddenFrom,
    type EventThreadMessage,
    type EventThreadView
} from './engine/event-thread.js';
export {
    ensureEventThread, syncEventThreadMembership, canReadEventThread, loadEventForThread,
    eventThreadReadOnlyReason, isEventThreadExpired, EVENT_THREAD_NOTICE, EVENT_THREAD_MESSAGE_MAX
} from './engine/event-thread.js';
import {
    parseReminderOffsets, getMemberDefaultReminderOffsets, setMemberDefaultReminderOffsets,
    tickEventReminders, BAD_OFFSETS_MESSAGE,
    setEventReminderOffsets as setEventReminderOffsetsEngine,
    listMyEvents as listMyEventsEngine,
} from './engine/event-reminders.js';
export {
    parseReminderOffsets, getMemberDefaultReminderOffsets, EVENT_REMINDER_OFFSETS,
    DEFAULT_EVENT_REMINDER_OFFSETS, EVENT_REMINDER_PREF_KEY, EVENT_REMINDER_GRACE_MS,
    BAD_OFFSETS_MESSAGE, NO_RSVP_MESSAGE, readStoredOffsets,
    dueEventReminders, runEventReminderSweep, reminderPushTitle, reminderPushBody,
    type MyEvent,
} from './engine/event-reminders.js';

/** "Your events" and the per-event reminder write, wired to this node's db. */
export const listMyEvents = (memberPubkey: string, nowMs?: number) => listMyEventsEngine(memberPubkey, nowMs);
export const setEventReminderOffsets = (postId: string, memberPubkey: string, offsets: number[] | null) =>
    setEventReminderOffsetsEngine(postId, memberPubkey, offsets);
import {
    getNodeRole,
    setNodeRole,
    type NodeRole,
    getSyncCursor,
    setSyncCursor,
    recordSyncAttempt,
    getCurrentImportOrigin,
    signSyncPayload as signSyncPayloadEngine,
    exportSyncState as exportSyncStateWrapper,
    importRemoteState as importRemoteStateEngine,
    writeSyncAuditLog,
    type ImportResult,
    type SyncAuditEntry,
} from './engine/sync.js';



// Load synonym map for FTS5 search keyword expansion from @beanpool/core
const synonymMap: Record<string, string[]> = { ...SYNONYM_MAP };
delete (synonymMap as any)._meta;

/**
 * Run a SELECT whose only large dynamic input is a single `IN (...)` array, splitting that
 * array into sub-batches so we never exceed SQLite's host-parameter cap (32766). Without this,
 * an array grown by user activity (posts, conversations, wards) could blow the cap and throw,
 * failing the request. `buildSql(placeholders)` returns the SQL for one batch; `prefixParams`
 * are bound (in order) before the array values and are identical across batches.
 */
function selectInChunks<T = any>(
    values: readonly any[],
    buildSql: (placeholders: string) => string,
    prefixParams: readonly any[] = [],
): T[] {
    const CHUNK_SIZE = 900;
    const out: T[] = [];
    for (let i = 0; i < values.length; i += CHUNK_SIZE) {
        const chunk = values.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        out.push(...(db.prepare(buildSql(placeholders)).all(...prefixParams, ...chunk) as T[]));
    }
    return out;
}

/**
 * Generate hidden search keywords by expanding post content through the synonym map.
 * e.g. title "Fresh Lemons" → keywords "fruit citrus produce food tree"
 */
export function generateSearchKeywords(title: string, description: string, category: string): string {
    return generateSearchKeywordsEngine(title, description, category, synonymMap);
}

// ===================== TYPES =====================

export type { Member, InviteCode };

export type { MarketplacePost };

export type { MarketplaceTransaction };

export interface Transaction {
    id: string;
    from: string;
    to: string;
    amount: number;
    taxFee?: number;
    memo: string;
    timestamp: string;
    // SRV-20: cryptographic authorship, carried over sync so importing nodes can
    // re-verify who authored the transaction. Absent on legacy/unsigned rows.
    authSigner?: string | null;
    authSignature?: string | null;
    authPayload?: string | null;
}

export type { MemberProfile };

type SystemMessageMetadata = TypedMessagePayload;
export { SystemMessageType };
export type { Conversation, Message, SystemMessageMetadata };

export type { Rating };

export interface AbuseReport {
    id: string;
    reporterPubkey: string;
    targetPubkey: string;
    targetPostId?: string;
    targetPulseItemId?: string;
    reason: string;
    createdAt: string;
    status?: string;
    reporterCallsign?: string;
    targetCallsign?: string;
    postTitle?: string | null;
    /** The same status in the moderation list's words: 'open' (pending), 'dismissed' (reviewed), 'actioned'. */
    outcome?: 'open' | 'dismissed' | 'actioned';
    /** The reported post's id, its author's callsign, and whether it is gone (null when no post is reported). */
    postId?: string | null;
    postAuthorCallsign?: string | null;
    postDescription?: string | null;
    postRemoved?: boolean | null;
    /** The reported post is hidden by reports, waiting for a moderator (global profile, G3). */
    postHiddenByReports?: boolean | null;
    /** Present when the report targets a Pulse item. `removed` is true once it is tombstoned (url/title are then NULL). */
    pulseItem?: { title: string | null; platform: string; url: string | null; removed: boolean } | null;
}

export type { FriendEntry };

export interface RecoveryRequest {
    id: string;
    oldPubkey: string;
    newPubkey: string;
    status: 'pending' | 'approved' | 'cancelled' | 'expired' | 'executed';
    quorumRequired: number;
    createdAt: string;
    cooldownUntil?: string;
    executedAt?: string;
    expiresAt: string;
}

export interface RecoveryApproval {
    requestId: string;
    guardianPubkey: string;
    decision: 'approve' | 'reject';
    createdAt: string;
}

export interface CommunityProject {
    id: string;
    title: string;
    description: string;
    proposerPubkey: string;
    proposerCallsign: string;
    requestedAmount: number;
    status: 'proposed' | 'active' | 'funded' | 'rejected' | 'completed';
    createdAt: string;
    fundedAt?: string;
}

export interface NodeConfig {
    serviceRadius?: { lat: number; lng: number; radiusKm: number };
    publishLocation?: boolean;
    publishMembers?: boolean;
    publishContacts?: boolean;
    publishHealth?: boolean;
    directoryPushIntervalHours?: number;
    lastDirectoryPush?: string;
    publicAddress?: {
        name?: string;
        mode?: 'tunnel' | 'direct';
        hostname?: string;
        status?: string;
        tunnelToken?: string;
    } | null;
    /**
     * Addresses an owner or admin confirmed in Settings as this community's own (engine/own-addresses.ts, source 3): a
     * custom domain or a proxy name the node can't learn from its config. Beside `publicAddress`, and carried with it
     * in the take-over envelope, so a promoted standby accepts the same names.
     */
    ownerAddresses?: string[];
}

const wsClients: Set<any> = new Set();

// ===================== INIT =====================

export function initStateEngine(): void {
    bumpPostsVersion();
    bumpMembersVersion();
    initSchema();
    clearEnterpriseFloorCache();
    migrateLegacyState();
    // NODE_PROFILE decides what the node runs as; node_config.nodeProfile records it, and a main server recorded as
    // global refuses to start under another profile (config/node-profile.ts). Before the ledger is loaded: a node
    // that must not open never reads it.
    mirrorNodeProfileAtBoot(getNodeRole());
    // Members' faces behind a member-only key in every avatar URL, where visitors see the listings and not the people
    // (G9a-2, engine/avatar-keys.ts). Decided here, once, so the URLs emitted and the URLs served agree.
    installAvatarKeysAtBoot();
    // Members' sign-in recovery copies are locked with a key kept outside this database (services/recovery-seal-key.ts):
    // a main server makes it if it has none and wraps any copy stored before it; a standby does neither. Before anything
    // serves. The key travels only inside the take-over bundle, so a take-over and a sealed-backup restore bring it.
    // Never throws.
    installRecoverySealAtBoot({ standby: getNodeRole() === 'backup' });
    // Recovery copies whose deletion this database recorded without applying it (a standby on a version from before
    // recovery tombstones), deleted now (engine/recovery-shares.ts). Never throws.
    applyRecordedRecoveryTombstones();
    // The one money path in db.ts (a crowdfund pledge) checks the Beans switch through this, as the hooks below do.
    setMoneyGuardHook(() => assertBeansOn());
    seedPulseCurated();
    
    // Seed SYSTEM user securely
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT OR IGNORE INTO members (public_key, callsign, invited_by, invite_code) VALUES ('SYSTEM', 'System', 'genesis', 'genesis')").run();

    // Load ledger accounts into LedgerManager
    const accounts = db.prepare("SELECT public_key as id, balance, last_demurrage_epoch as lastDemurrageEpoch FROM accounts").all() as any[];
    if (accounts.length > 0) {
        ledger.loadState(accounts);
    }

    // A2-1: register the balance-mutation hook so any raw-SQL balance change in
    // db.ts (crowdfund pledge/refund) re-syncs the in-memory ledger from the DB,
    // preventing a stale in-memory balance from being written back over the DB by
    // the next transfer() (which would erase the mutation = credit minting).
    setBalanceMutationHook(reconcileLedgerFromDb);

    // #138: and the mirror of it. Those same raw-SQL paths also RAISE balances (the escrow sweep to a
    // project creator, a refund to every backer) without closing the demurrage window, so the account's
    // next read charges the whole stale interval against the newly larger balance. db.ts settles the
    // affected accounts through this hook first — same dependency inversion, for the same module-cycle
    // reason as above.
    setDemurrageSettleHook(settleDemurrage);

    // Onboarding funnel retention. Once at startup rather than behind the read, because a
    // DELETE on the read path both takes a write lock and can destroy what the caller
    // asked for — a request for a year of history would have pruned to 180 days first and
    // then answered as though that was all there had ever been.
    pruneFunnel();

    // CRITICAL: Restore persisted commons balance from DB
    // Without this, COMMONS_BALANCE resets to 0 on every restart, destroying accumulated demurrage
    //
    // Restores ANY recorded figure, including a NEGATIVE one (review finding). The old `> 0` test silently
    // reset a deficit to zero on every restart — which would erase the record of a write-off the community
    // has actually made and break conservation across a reboot, in the one direction where the books are
    // already strained. A deficit is a real state now that `payFromCommons({ allowDeficit })` exists, and
    // docs/commons-pool-transparency.md's Solvency Rule requires the pot to absorb write-offs even when
    // empty. It has to survive a restart to mean anything.
    const commonsRow = db.prepare("SELECT balance FROM accounts WHERE public_key = 'COMMONS_POOL'").get() as any;
    if (commonsRow && typeof commonsRow.balance === 'number') {
        setCommonsBalance(commonsRow.balance);
        const note = commonsRow.balance < 0 ? ' ⚠️ IN DEFICIT — write-offs have exceeded collections' : '';
        console.log(`🏛️ Restored Commons Pool balance: ${commonsRow.balance.toFixed(2)}${note}`);
    } else {
        // Seed the COMMONS_POOL account if it doesn't exist
        db.prepare("INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES ('COMMONS_POOL', 0, 0)").run();
        console.log(`🏛️ Commons Pool account seeded (starting from 0)`);
    }

    // Community treasuries are real members but, like the Commons pool, are exempt from demurrage.
    // Re-register their exemptions in the freshly-loaded in-memory ledger on every boot.
    try {
        const treasuries = db.prepare("SELECT public_key FROM members WHERE is_treasury = 1").all() as any[];
        for (const t of treasuries) ledger.setDecayExempt(t.public_key);
        if (treasuries.length > 0) console.log(`🏛️ Registered ${treasuries.length} treasury account(s) as demurrage-exempt`);
    } catch (e) { console.warn('[Treasury] Failed to register demurrage exemptions:', e); }

    // #104 — inter-node energy balances are obligations, not hoards. The exemption set lives in the
    // in-memory ledger and is rebuilt each boot, so an exemption that isn't re-applied here would
    // silently start decaying a debt — i.e. forgiving it (docs/federation-economics.md §2.4).
    try {
        const n = registerBridgeDecayExemptions();
        if (n > 0) console.log(`🌉 Registered ${n} bridge account(s) as demurrage-exempt`);
    } catch (e) { console.warn('[Federation] Failed to register bridge demurrage exemptions:', e); }

    // #143 step 3's link reconcile USED TO BE HERE, and could not work: this function runs before
    // `initConnectorManager` has loaded connectors.json, so `getConnectors()` was empty and it created
    // nothing, silently. Moved to index.ts step 8.05, immediately after the connector manager. See the note
    // there — it is the sixth instance of this feature shipping code that nothing ever executed.

    // Start periodic persistence of commons balance + demurrage ledger rows (every 5 minutes)
    //
    // ONE commit, not two (review finding). These used to be separate autocommits under separate catches,
    // so a crash — or just the first one succeeding and the second throwing — left the decay debits durable
    // with their matching Commons credit missing, which boot then rebuilds from as the truth. The pair is
    // the unit; half of it is worse than none of it.
    setInterval(() => {
        try { persistDecayAndCommons(); } catch (e) { console.warn('[Ledger] Failed to persist the demurrage flush:', e); }
    }, 5 * 60 * 1000);

    // #129: Run the ledger conservation audit IMMEDIATELY at startup so drift
    // appears in the boot log and cannot go unnoticed between releases.
    // The delayed versions below handle periodic re-checks during operation.
    try {
        const auditResult = runLedgerAudit();
        if (!auditResult.ok) {
            console.error('');
            console.error('╔════════════════════════════════════════════════════════╗');
            console.error('║ ⚠️  LEDGER CONSERVATION WARNING — NODE STARTED WITH DRIFT ║');
            console.error('╠════════════════════════════════════════════════════════╣');
            console.error(`║  sum(balances) = ${String(auditResult.sumBalances.toFixed(4)).padEnd(10)} baseline = ${String(auditResult.baseline.toFixed(4)).padEnd(10)}    ║`);
            console.error(`║  drift         = ${String(auditResult.drift.toFixed(4)).padEnd(10)} stranded = ${String(auditResult.strandedEscrows).padEnd(10)}    ║`);
            console.error('║                                                        ║');
            console.error('║  Run POST /api/local/admin/ledger-audit to inspect.   ║');
            console.error('║  Run POST /api/local/admin/ledger-rebaseline to       ║');
            console.error('║  acknowledge known drift with a written explanation.  ║');
            console.error('╚════════════════════════════════════════════════════════╝');
            console.error('');
        }
    } catch (e) { console.warn('[LedgerAudit] startup check failed:', e); }

    // One key, one spelling (engine/member-key.ts). A person's row stored under a key written another way (in capitals,
    // say) by a door before this version is logged, with what the operator should do. Nothing is merged or deleted: it
    // is a person's data. On a standby too, which holds the same rows. Never throws.
    reportMisspeltMemberKeys();

    // Daily ledger conservation audit (also once shortly after boot)
    setTimeout(() => {
        try { runLedgerAudit(); } catch (e) { console.warn('[LedgerAudit] failed:', e); }
    }, 2 * 60 * 1000);
    setInterval(() => {
        try { runLedgerAudit(); } catch (e) { console.warn('[LedgerAudit] failed:', e); }
    }, 24 * 60 * 60 * 1000);

    // Daily Wash & Sybil metrics audit (once shortly after boot, then daily)
    setTimeout(() => {
        try { runWashSybilMetricsAudit(); } catch (e) { console.warn('[MetricsAudit] failed:', e); }
    }, 2.5 * 60 * 1000);
    setInterval(() => {
        try { runWashSybilMetricsAudit(); } catch (e) { console.warn('[MetricsAudit] failed:', e); }
    }, 24 * 60 * 60 * 1000);

    if (getNodeRole() === 'primary') {
        // One-time migration: move escrow funds from old post-keyed wallets to transaction-keyed wallets
        migrateEscrowWalletKeys();

        // One-time migration: collapse per-post chat threads into one per-pair DM (chat consolidation)
        migrateConsolidateConversations();
        repairConsolidatedMessagesMetadata();

        // Groups redesign slice 1 (2026-09-19): the old chat groups are deleted outright (decision 2), and
        // every Commons group gets its chat (decision 3). Both idempotent; tombstones carry the delete to backups.
        try { removeOldChatGroups(); } catch (e) { console.warn('[Groups] Could not remove old chat groups:', e); }
        try {
            const made = backfillGroupThreads();
            if (made > 0) console.log(`[Groups] Gave ${made} existing group(s) their chat.`);
        } catch (e) { console.warn('[Groups] Could not backfill group chats:', e); }
    }

    // A convenor who comes back cancels any vote to replace them, with a line in the group's chat.
    setMemberActivityHook((pk) => {
        try { if (cancelGroupSuccessionIfConvenorActive(getMessagingCb(), pk) > 0) bumpGroupsVersion(); }
        catch (e) { console.warn('[Groups] Could not close a convenor vote:', e); }
    });

    // FTS5: Backfill search keywords for existing posts that don't have them
    backfillSearchKeywords();

    // Purge legacy synthetic wallet entries that leaked into the members table
    purgeSyntheticMembers();

    // Sweep zero-balance escrow accounts from settled/cancelled transactions
    sweepSettledEscrowAccounts();

    // Marketplace hygiene: expire stale requests, nudge lingering escrows (hourly + once at
    // boot). Primary only — it dispatches real push notifications to members, which a
    // passive backup replica must never do independently of the primary it mirrors.
    if (getNodeRole() === 'primary') {
        setTimeout(() => {
            try { runMarketplaceHygiene(); } catch (e) { console.warn('[Marketplace] Hygiene sweep failed:', e); }
        }, 60 * 1000);
        setInterval(() => {
            try { runMarketplaceHygiene(); } catch (e) { console.warn('[Marketplace] Hygiene sweep failed:', e); }
        }, 60 * 60 * 1000);

        // Community Decisions Engine (§3.4, §3.7): periodic tick to close expired voting windows,
        // evaluate passed grants queue, and fire expired grace-period prunes.
        setTimeout(() => {
            try { tickDecisions(); } catch (e) { console.warn('[Decisions] Periodic tick failed:', e); }
        }, 30 * 1000);
        setInterval(() => {
            try { tickDecisions(); } catch (e) { console.warn('[Decisions] Periodic tick failed:', e); }
            // Keeper changes whose 3-day objection window has ended, and succession proposals past their deadline.
            try { tickEnterpriseKeepers(); } catch (e) { console.warn('[Keepers] Periodic tick failed:', e); }
            // Group convenor votes past their 14-day deadline.
            try { tickGroupSuccession(); } catch (e) { console.warn('[Groups] Convenor vote tick failed:', e); }
            // Event reminders that have come round (docs/events-on-the-map.md §2.2). Every minute, because
            // the tightest offer is 30 minutes and a reminder is worth nothing once it is stale; the sweep
            // itself is bounded by one indexed range scan over events starting inside the next week.
            try { tickEventReminders(dispatchPushNotification); } catch (e) { console.warn('[Events] Reminder sweep failed:', e); }
        }, 60 * 1000);
    }

    const memberCount = db.prepare("SELECT COUNT(*) as c FROM members").get() as any;
    const postCount = db.prepare("SELECT COUNT(*) as c FROM posts").get() as any;
    console.log(`📒 SQLite DB initialized: ${memberCount.c} members, ${postCount.c} posts`);
}

/**
 * One-time backfill: Generate search keywords for all existing posts that lack them.
 * Also rebuilds the FTS5 index to ensure it's in sync.
 */
function backfillSearchKeywords(): void {
    const posts = db.prepare(`SELECT id, title, description, category FROM posts WHERE search_keywords = '' OR search_keywords IS NULL`).all() as any[];
    if (posts.length === 0) return;

    console.log(`🔍 Backfilling FTS5 search keywords for ${posts.length} posts...`);
    
    // Step 1: Drop and recreate FTS5 table + triggers to avoid corruption
    // (external content table gets out of sync when rows existed before triggers were created)
    try {
        db.exec(`DROP TRIGGER IF EXISTS posts_ai`);
        db.exec(`DROP TRIGGER IF EXISTS posts_ad`);
        db.exec(`DROP TRIGGER IF EXISTS posts_au`);
        db.exec(`DROP TABLE IF EXISTS posts_fts`);
    } catch (e) {
        console.warn('[FTS] Cleanup failed:', e);
    }

    // Step 2: Update keywords on all posts
    const update = db.prepare(`UPDATE posts SET search_keywords = ? WHERE id = ?`);
    db.transaction(() => {
        for (const p of posts) {
            const keywords = generateSearchKeywords(p.title || '', p.description || '', p.category || 'general');
            update.run(keywords, p.id);
        }
    })();

    // Step 3: Recreate FTS5 table and triggers (now all data has keywords)
    try {
        db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
                title, description, search_keywords,
                content='posts',
                content_rowid='rowid'
            );

            CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
                INSERT INTO posts_fts(rowid, title, description, search_keywords)
                VALUES (new.rowid, new.title, new.description, new.search_keywords);
            END;

            CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
                INSERT INTO posts_fts(posts_fts, rowid, title, description, search_keywords)
                VALUES ('delete', old.rowid, old.title, old.description, old.search_keywords);
            END;

            -- Must match schema.sql's posts_au, WHEN included: without it the touch trigger's nested
            -- UPDATE desyncs the index (#878). test-posts-fts-same-ms fails if the two drift.
            CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts
            WHEN OLD.title IS NOT NEW.title
              OR OLD.description IS NOT NEW.description
              OR OLD.search_keywords IS NOT NEW.search_keywords
            BEGIN
                INSERT INTO posts_fts(posts_fts, rowid, title, description, search_keywords)
                VALUES ('delete', old.rowid, old.title, old.description, old.search_keywords);
                INSERT INTO posts_fts(rowid, title, description, search_keywords)
                VALUES (new.rowid, new.title, new.description, new.search_keywords);
            END;
        `);
        // Rebuild index with all current data
        db.exec(`INSERT INTO posts_fts(posts_fts) VALUES('rebuild')`);
    } catch (e) {
        console.warn('[FTS] FTS5 table recreation failed:', e);
    }
    
    console.log(`✅ FTS5 search keywords backfilled for ${posts.length} posts.`);
}

/**
 * One-time migration: Existing pending transactions have funds in escrow_<post_id>.
 * New code expects escrow_<transaction_id>. Move funds from old to new wallet key.
 * Safe to re-run: it checks if the old wallet has a balance before attempting.
 */
function migrateEscrowWalletKeys(): void {
    const pending = db.prepare("SELECT id, post_id, credits FROM marketplace_transactions WHERE status='pending'").all() as any[];
    if (pending.length === 0) return;

    let migrated = 0;
    for (const tx of pending) {
        const oldKey = `escrow_${tx.post_id}`;
        const newKey = `escrow_${tx.id}`;

        // Check if funds are already in the new wallet (already migrated)
        const newAcc = ledger.getAccount(newKey);
        if (newAcc && newAcc.balance > 0) continue;

        // Check if old wallet has funds to migrate
        const oldAcc = ledger.getAccount(oldKey);
        if (!oldAcc || oldAcc.balance <= 0) {
            console.warn(`[Migration] Cannot migrate escrow for tx ${tx.id}: old wallet ${oldKey} has no balance`);
            continue;
        }

        // Transfer whatever the old wallet actually has (may be slightly less than tx.credits due to demurrage).
        // For recurring posts, the old wallet may serve multiple transactions, so take only this tx's share.
        const amountToMove = Math.min(oldAcc.balance, tx.credits);

        // Ensure the new escrow wallet has a row in the accounts table
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(newKey);

        // Move funds: old wallet -> new wallet
        const result = transfer(oldKey, newKey, amountToMove, `Escrow wallet key migration: ${oldKey} -> ${newKey}`, 'escrow', true);
        if (result) {
            migrated++;
            console.log(`[Migration] ✅ Migrated ${amountToMove} beans from ${oldKey} to ${newKey} (original: ${tx.credits})`);
        } else {
            console.error(`[Migration] ❌ Failed to migrate escrow for tx ${tx.id}`);
        }
    }
    if (migrated > 0) {
        console.log(`[Migration] Escrow wallet key migration complete: ${migrated}/${pending.length} transactions migrated`);
    }
}

/**
 * One-time migration: Remove synthetic wallet entries (escrow_*, project_*) that
 * leaked into the members table before the transfer() guard was added.
 * Safe to re-run — only deletes members whose public_key matches synthetic patterns.
 */
function purgeSyntheticMembers(): void {
    const result = db.prepare(
        "DELETE FROM members WHERE public_key LIKE 'escrow_%' OR public_key LIKE 'project_%'"
    ).run();
    if (result.changes > 0) {
        console.log(`🧹 Purged ${result.changes} synthetic wallet entries from members table (escrow_*/project_*)`);
    }
}

/**
 * Sweep zero-balance escrow accounts from completed/cancelled transactions.
 * Only deletes accounts where:
 *   1. public_key starts with 'escrow_'
 *   2. balance is 0
 *   3. No pending marketplace_transaction references that escrow wallet
 * Safe to re-run and to call periodically.
 */
// How long a 'requested' transaction may sit unanswered before it auto-expires,
// and how often a buyer is nudged about a deal lingering in escrow.
const REQUEST_TTL_DAYS = 7;
const ESCROW_NUDGE_DAYS = 7;

export function runMarketplaceHygiene(): void {
    // 1. Expire 'requested' transactions that nobody answered. No funds are locked
    // at the 'requested' stage, so expiry is purely a bookkeeping cleanup.
    const stale = db.prepare(`SELECT * FROM marketplace_transactions WHERE status='requested' AND created_at < datetime('now', ?)`)
        .all(`-${REQUEST_TTL_DAYS} days`) as any[];
    for (const row of stale) {
        db.prepare(`UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND status='requested'`).run(row.id);
        const post = db.prepare(`SELECT title, type, author_pubkey FROM posts WHERE id=?`).get(row.post_id) as any;
        const requesterPubkey = post && post.type === 'need' ? row.seller_pubkey : row.buyer_pubkey;
        dispatchPushNotification(
            [requesterPubkey, post?.author_pubkey].filter(Boolean),
            'SYSTEM',
            '⌛ Request Expired',
            `The request for "${post?.title || 'a post'}" expired after ${REQUEST_TTL_DAYS} days without a response.`,
            { screen: 'post', postId: row.post_id },
            'marketplace'
        );
    }
    if (stale.length > 0) console.log(`🧹 Expired ${stale.length} stale marketplace request(s)`);

    // 2. Nudge buyers whose deals have been sitting in escrow — beans in limbo
    // help nobody. Re-nudges every ESCROW_NUDGE_DAYS via last_reminded_at.
    const lingering = db.prepare(`
        SELECT t.*, p.title AS post_title FROM marketplace_transactions t
        LEFT JOIN posts p ON p.id = t.post_id
        WHERE t.status='pending'
          AND t.created_at < datetime('now', ?)
          AND (t.last_reminded_at IS NULL OR t.last_reminded_at < datetime('now', ?))
    `).all(`-${ESCROW_NUDGE_DAYS} days`, `-${ESCROW_NUDGE_DAYS} days`) as any[];
    for (const row of lingering) {
        dispatchPushNotification(
            [row.buyer_pubkey],
            'SYSTEM',
            '⏳ Deal Awaiting Completion',
            `"${row.post_title || 'A deal'}" has been in escrow for over ${ESCROW_NUDGE_DAYS} days — release the Beans to the seller or cancel the deal.`,
            { screen: 'post', postId: row.post_id },
            'marketplace'
        );
        db.prepare(`UPDATE marketplace_transactions SET last_reminded_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(row.id);
    }
    if (lingering.length > 0) console.log(`⏳ Nudged ${lingering.length} lingering escrow deal(s)`);

    // 3. Prune old activity feed entries past 30-day retention
    try {
        const pruned = pruneOldActivity(30);
        if (pruned > 0) console.log(`🌊 Pruned ${pruned} activity feed event(s) older than 30 days`);
    } catch (e) {
        console.warn('[ActivityFeed] Hygiene prune failed:', e);
    }

    // 4. The moderation notices kept for members (engine/kept-notices.ts): none older than 60 days, each member's newest 50.
    try {
        const tidied = tidyKeptNotices();
        if (tidied > 0) console.log(`🛡️ Tidied ${tidied} kept moderation notice(s) past their bounds`);
    } catch (e) {
        console.warn('[Notices] Hygiene tidy failed:', e);
    }
}

function sweepSettledEscrowAccounts(): void {
    const DUST_THRESHOLD = 1e-6;
    // #160: Absorb floating-point dust (< 1e-6) on settled escrow accounts into COMMONS_POOL in SQLite & memory before sweeping.
    // Uses indexed NOT EXISTS query to avoid unindexed table scans.
    const dustSumRow = db.prepare(`
        SELECT COALESCE(SUM(balance), 0) AS dustSum
        FROM accounts 
        WHERE public_key LIKE 'escrow_%' 
          AND ABS(balance) < ? 
          AND ABS(balance) > 0
          AND NOT EXISTS (
              SELECT 1 FROM marketplace_transactions mt 
              WHERE mt.id = SUBSTR(accounts.public_key, 8) 
                AND mt.status IN ('pending', 'requested')
          )
    `).get(DUST_THRESHOLD) as { dustSum: number };

    if (dustSumRow && dustSumRow.dustSum !== 0) {
        setCommonsBalance(COMMONS_BALANCE + dustSumRow.dustSum);
        db.prepare(`
            UPDATE accounts 
            SET balance = balance + ?,
                last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE public_key = 'COMMONS_POOL'
        `).run(dustSumRow.dustSum);
    }

    db.prepare(`
        UPDATE accounts 
        SET balance = 0,
            last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE public_key LIKE 'escrow_%' 
          AND ABS(balance) < ? 
          AND ABS(balance) > 0
          AND NOT EXISTS (
              SELECT 1 FROM marketplace_transactions mt 
              WHERE mt.id = SUBSTR(accounts.public_key, 8) 
                AND mt.status IN ('pending', 'requested')
          )
    `).run(DUST_THRESHOLD);

    const result = db.prepare(`
        DELETE FROM accounts 
        WHERE public_key LIKE 'escrow_%' 
          AND balance = 0
          AND NOT EXISTS (
              SELECT 1 FROM marketplace_transactions mt 
              WHERE mt.id = SUBSTR(accounts.public_key, 8) 
                AND mt.status IN ('pending', 'requested')
          )
    `).run();
    if (result.changes > 0) {
        console.log(`🧹 Swept ${result.changes} settled escrow accounts with zero balance`);
    }
}

// ===================== WEBSOCKET =====================

export function addWsClient(ws: any): void {
    wsClients.add(ws);
    try {
        const counts = getCommunityInfo();
        ws.send(JSON.stringify({
            type: 'state_snapshot',
            memberCount: counts.memberCount,
            postCount: counts.postCount,
            commonsBalance: COMMONS_BALANCE,
        }));
    } catch { /* ignore */ }
}

export function removeWsClient(ws: any): void {
    wsClients.delete(ws);
}

// The ETag version counters now live in engine/versions.ts — a dependency-free module, so that
// low-level engine code (engine/members.ts registerVisitor, for one) can bump them without
// importing state-engine and creating a cycle. Re-exported here so existing callers are unchanged.
import { bumpPostsVersion, bumpMembersVersion, bumpActivityVersion } from './engine/versions.js';
import { noteTakeoverInputsChanged } from './services/takeover-signal.js';
export { getPostsVersion, bumpPostsVersion, getMembersVersion, bumpMembersVersion, getActivityVersion, bumpActivityVersion } from './engine/versions.js';

// SRV-4: what a /ws socket without a verified member gets (see WS_AUTH_MODE in https-server.ts).
// Deny by default: only changes to things anyone can already read unsigned — the public
// marketplace board, commons projects, decisions, enterprise map pins — and only as a bare
// `{ type }` doorbell with no payload, which is all a client uses them for (it re-fetches what
// it may see). Everything else — messages, trades, amounts, members, profiles, announcements,
// groups — goes to member sockets only. An event scoped with `recipients` never reaches a
// socket without a member, whatever its type.
export const PUBLIC_WS_EVENTS: ReadonlySet<string> = new Set([
    'new_post', 'post_updated', 'post_removed',
    'project_created', 'project_updated', 'project_deleted',
    'decision_created', 'decision_updated', 'decision_vote_cast', 'decision_halted',
    'enterprise_location_updated', 'enterprise_wound_up',
    'state_synced',
]);

// A2-20: the /ws feed is global — every connected member receives every broadcast.
// For privacy-sensitive events (a ledger transfer reveals who paid whom + amounts),
// pass `recipients` so the event is delivered ONLY to sockets whose verified member
// is a party. General community events (new_post, member_joined, profile_updated)
// pass no recipients and reach every member socket; sockets with no verified member
// get only PUBLIC_WS_EVENTS, as a bare doorbell, unless the operator chose the open
// feed (ENFORCE_WS_AUTH=false), where they get every event without recipients.
//
// Three things a socket's verified key decides, as for an HTTP read:
//   - `_memberPubkey`, a key that passes the act test (isNodeMember), or a visitor's (isLiveVisitor): what is sent TO
//     it as a party (`recipients`), its own messages, trades and Beans. A suspended or disabled member's socket keeps
//     this.
//   - `_visitor`, a visitor's key: of what is sent to it as a party, only what isLiveVisitor lets it read over HTTP,
//     its direct conversations and its Beans (visitorMayReceive). A group's chat, an event's chat or note, a trade: none
//     of them, even where a row from before this rule still names it.
//   - `_memberFeed`, a key that reads as a member (readsAsMember): the member feed, everything else a member socket
//     gets (community events, poll voters, the doorbells of other people's private events). A suspended or disabled
//     member's socket, while that lasts, and a visitor's get only what a stranger's gets here.
//
// `othersGetDoorbell`: a private event whose side effect everyone may see (a listing going pending, a
// completed trade on the activity feed). The recipients get the full event; every other member socket
// (and an open-feed socket) gets only `{ type }`, so its client re-fetches what it may see. Clients use
// nothing but the type of these events, so the doorbell refreshes them exactly as the payload did.
//
// Returns how many open sockets it was written to.
export interface BroadcastOptions { othersGetDoorbell?: boolean }
export function broadcast(event: any, recipients?: string[], opts?: BroadcastOptions): number {
    // A post hidden by reports (engine/auto-moderation.ts) goes in full to its author only, whatever sent it (an
    // edit, a vote, an RSVP); everyone else gets `{ type, id }`, which no app applies as a listing, so each one's
    // catch-up sync gets what it may see: the moderators the post, everyone else a removal.
    if ((event?.type === 'new_post' || event?.type === 'post_updated') && event.post?.hiddenByReportsAt) {
        const author = event.post.authorPublicKey;
        const toAuthor = typeof author === 'string' && (!recipients || recipients.includes(author)) ? deliverBroadcast(event, [author]) : 0;
        return toAuthor + deliverBroadcast({ type: 'post_updated', id: event.post.id }, recipients);
    }
    return deliverBroadcast(event, recipients, opts);
}

/**
 * What a /ws socket's verified key gets: what is sent to it as a party (`act`), only its own direct conversations and
 * Beans of that (`visitor`), and the member feed (`feed`).
 */
export interface SocketStanding { act: boolean; visitor: boolean; feed: boolean }

/**
 * A socket key's standing: act is isNodeMember or isLiveVisitor, visitor is isLiveVisitor, feed is readsAsMember (which
 * needs isNodeMember). Pass the verified key.
 */
export function socketStanding(pubkey: string): SocketStanding {
    const member = isNodeMember(pubkey);
    const visitor = !member && isLiveVisitor(pubkey);
    return { act: member || visitor, visitor, feed: member && readsAsMember(pubkey) };
}

/** Event types carrying a direct conversation's id (`conversationId`, or `conversation.id`), and a transfer's. */
const VISITOR_CHAT_EVENTS: ReadonlySet<string> = new Set(['new_message', 'message_edited', 'message_reaction', 'conversation_created']);

/**
 * Whether an event sent to a visitor's socket as a party is one it may have: a line, an edit, a reaction or the
 * opening of a direct conversation (a DM) it is in, or a transfer of its Beans. Anything else addressed to it is not
 * delivered: a group's chat, an event's chat, a post's update, a trade. Its HTTP reads are held to the same
 * (https-server.ts visitorsOwnRead).
 */
function visitorMayReceive(event: any): boolean {
    const type = event?.type;
    if (type === 'transaction') return true;
    if (!VISITOR_CHAT_EVENTS.has(type)) return false;
    const conversationId = typeof event.conversationId === 'string' ? event.conversationId : event.conversation?.id;
    if (typeof conversationId !== 'string') return false;
    const conv = db.prepare('SELECT type FROM conversations WHERE id = ?').get(conversationId) as { type: string } | undefined;
    return conv?.type === 'dm';
}

function deliverBroadcast(event: any, recipients?: string[], opts?: BroadcastOptions): number {
    if (event && typeof event.type === 'string') {
        switch (event.type) {
            case 'new_post':
                bumpPostsVersion();
                if (!recipients) {
                    bumpActivityVersion();
                }
                break;
            case 'post_updated':
            case 'post_removed':
            case 'post_accepted':
            case 'transaction_requested':
            case 'transaction_rejected':
            case 'transaction_cancelled':
                bumpPostsVersion();
                break;
            case 'transaction_completed':
                bumpPostsVersion();
                bumpActivityVersion();
                break;
            case 'member_joined':
                bumpMembersVersion();
                bumpActivityVersion();
                break;
            case 'treasury_created':
                bumpMembersVersion();
                break;
            case 'profile_updated':
                bumpMembersVersion();
                bumpPostsVersion(); // Profiles affect marketplace listings (e.g., holiday mode, callsigns)
                bumpActivityVersion(); // Profile updates change member callsigns joined in activity feed
                break;
            case 'state_synced':
                bumpGroupsVersion();
                bumpPostsVersion();
                bumpMembersVersion();
                bumpActivityVersion();
                break;
            case 'user_pruned':
                bumpPostsVersion();
                bumpMembersVersion();
                bumpActivityVersion();
                break;
        }
    }
    const msg = JSON.stringify(event);
    // Every socket's key is the one spelling (https-server.ts verifyWsConnect, engine/member-key.ts), and so is every
    // key a join writes, so the socket-standing matches below are exact: a case-blind one would take an event about a
    // row an old door stored under another spelling of a member's key (member-key.ts reportMisspeltMemberKeys) for
    // news about that member.
    const joinedPubkey = event?.type === 'member_joined' && typeof event.member?.publicKey === 'string'
        ? event.member.publicKey : null;
    let doorbell: string | null = null;
    // Who voted for what in a poll goes to member sockets only (withoutPollVoters). On the open feed
    // (ENFORCE_WS_AUTH=false) a socket with no verified member gets the whole event, so its copy of the post
    // leaves the voters off and keeps the counts.
    const carriesVoters = (event?.type === 'new_post' || event?.type === 'post_updated')
        && !!event.post && typeof event.post === 'object' && 'pollVotes' in event.post;
    let withoutVoters: string | null = null;
    // The joined key's standing, asked once, and only if some socket holds that key.
    let joined: SocketStanding | undefined;
    // Whether a visitor's socket, as a party, may have this event (visitorMayReceive), asked once.
    let forVisitor: boolean | undefined;
    let sent = 0;
    for (const ws of wsClients) {
        // Someone who signed their connect before their membership existed (mid-join) becomes a member socket now, and a
        // visitor's socket whose row just became a member's gets the member feed. Only for a key that is a member now:
        // member_joined alone never makes one (a replaced key, whatever announced it, stays a stranger's socket).
        if (joinedPubkey && (ws._pendingMemberPubkey === joinedPubkey || ws._memberPubkey === joinedPubkey)) {
            joined ??= socketStanding(event.member.publicKey);
            if (joined.act) {
                ws._memberPubkey = event.member.publicKey;
                ws._visitor = joined.visitor;
                ws._memberFeed = joined.feed;
                ws._pendingMemberPubkey = null;
            }
        }
        let out = msg;
        if (recipients && (!ws._memberPubkey || !recipients.includes(ws._memberPubkey))) {
            if (!opts?.othersGetDoorbell) continue;
            if (!ws._memberFeed && !ws._openFeed && !PUBLIC_WS_EVENTS.has(event?.type)) continue;
            out = doorbell ??= JSON.stringify({ type: event.type });
        } else if (recipients && ws._visitor) {
            if (!(forVisitor ??= visitorMayReceive(event))) continue;
        } else if (!recipients && !ws._memberFeed && !ws._openFeed) {
            if (!PUBLIC_WS_EVENTS.has(event?.type)) continue;
            out = doorbell ??= JSON.stringify({ type: event.type });
        } else if (!ws._memberFeed && carriesVoters) {
            out = withoutVoters ??= JSON.stringify({ ...event, post: withoutPollVoters(event.post) });
        }
        try {
            ws.send(out);
            if (ws.readyState === 1) sent++; // OPEN
        } catch { wsClients.delete(ws); }
    }
    // An open socket's key is asked again whenever that key's standing may have changed, so the socket gets from then on
    // what a fresh connect with that key would. A key that no longer makes a member (isNodeMember) stops being a member
    // socket for good: a prune says so outright, a re-key started for a lost or stolen phone announces profile_updated
    // for the old key (issueRekeyCode), and one completed announces member_rekeyed. A suspension and its end announce
    // profile_updated too (adminSetUserStatus, a community vote, a report's action), so a suspended member's socket stops
    // getting the member feed while it lasts and gets it again after, keeping what is sent to it throughout. Exactly that
    // key: removing a stray row under a member's key in capitals (as reportMisspeltMemberKeys tells an operator to) is
    // no news about the member, whose open app would otherwise stop getting its messages and Beans (4111765291).
    const changedKey = event?.type === 'member_rekeyed' ? event.oldPublicKey
        : event?.type === 'user_pruned' || event?.type === 'profile_updated' ? event.publicKey : null;
    if (typeof changedKey === 'string') {
        let standing: SocketStanding | undefined;
        for (const ws of wsClients) {
            if (ws._memberPubkey !== changedKey) continue;
            standing ??= event.type === 'user_pruned' ? { act: false, visitor: false, feed: false } : socketStanding(ws._memberPubkey);
            if (!standing.act) ws._memberPubkey = null;
            ws._visitor = standing.visitor;
            ws._memberFeed = standing.feed;
        }
    }
    return sent;
}

// ===================== DB HELPERS =====================

export function assertMemberActive(publicKey: string): void {
    if (isSyntheticAccount(publicKey)) return;
    const cleanKey = typeof publicKey === 'string' ? publicKey.trim().toLowerCase() : '';
    try {
        const invalidated = db.prepare("SELECT reason, rekeyed_to FROM invalidated_keys WHERE public_key = ? COLLATE NOCASE").get(cleanKey) as any;
        if (invalidated) {
            const rekeyDetail = invalidated.rekeyed_to ? ` and re-keyed to ${invalidated.rekeyed_to}` : '';
            throw new Error(`Device key has been invalidated (${invalidated.reason}${rekeyDetail}). Please re-enrol using your replacement device.`);
        }
    } catch (e: any) {
        if (e?.message?.includes('Device key has been invalidated')) throw e;
        // If table does not exist during early boot or mock, ignore
    }
    // The row under exactly this key, else the member's row in the one spelling keys are kept in (engine/member-key.ts).
    // Not a case-blind match, which could answer with a row a door stored under that key in capitals before that rule
    // (pruned by an operator, say) and refuse the member whose key it is.
    const statusOf = db.prepare("SELECT status FROM members WHERE public_key = ?");
    const member = (statusOf.get(publicKey) ?? statusOf.get(cleanKey)) as any;
    if (!member) throw new Error('Member not found');
    if (member.status === 'disabled' || member.status === 'suspended') throw new Error('Account is suspended or disabled');
    if (member.status === 'pruned') throw new Error('Account has been pruned');
    if (member.status === 'completed') throw new Error('Enterprise has wound up — account closed');
}

export function assertProfileComplete(publicKey: string): void {
    const member = db.prepare("SELECT avatar_url, callsign FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member) return; // Let assertMemberActive handle missing members
    // See the identical gate in engine/posts.ts: a stored /api/avatar/ URL is not a photo.
    if (!isServableAvatarValue(member.avatar_url)) {
        throw new Error('Please set a profile photo before using the marketplace. Tap your profile to add one.');
    }
    if (!member.callsign || member.callsign.trim().length < 2) {
        throw new Error('Please set a display name before using the marketplace.');
    }
}



// ===================== MEMBERS =====================

export { seedGenesisMember, registerVisitor };

export function registerMember(publicKey: string, callsign: string): Member | null {
    return registerMemberEngine(broadcast, publicKey, callsign);
}

export function getMember(publicKey: string): Member | undefined {
    return getMemberEngine(db, publicKey);
}

export function getMembers(): Member[] {
    return getMembersEngine(db);
}

export function getAllMembers(): Member[] {
    return getAllMembersEngine(db);
}

// ===================== INVITE CODES =====================

export { generateInvite, adminGenerateInvite };

/** `joinerSigned`: the request carries a fresh signature by `publicKey` itself, the only way a visitor's row joins. */
export function redeemInvite(code: string, publicKey: string, callsign: string, joinerSigned = false): { success: boolean; error?: string; member?: Member; alreadyMember?: boolean } {
    return redeemInviteEngine(broadcast, code, publicKey, callsign, joinerSigned);
}

export function redeemOfflineTicket(ticketB64: string, joinerPublicKey: string, callsign: string, joinerSigned = false): { success: boolean; error?: string; member?: Member; alreadyMember?: boolean } {
    return redeemOfflineTicketEngine(broadcast, ticketB64, joinerPublicKey, callsign, joinerSigned);
}

export function checkInvite(codeOrTicket: string): InviteCheckResult {
    return checkInviteEngine(db, codeOrTicket, ticketBinding);
}

export function getInvitesByMember(pubkey: string): InviteCode[] {
    return getInvitesByMemberEngine(db, pubkey);
}

export function getInviteTree(rootPubkey?: string): InviteTreeNode[] {
    return getInviteTreeEngine(db, rootPubkey);
}

export type { InviteCheckResult, InviteTreeNode };

// ===================== PROFILES =====================

export function getProfile(publicKey: string, requesterPubkey?: string): MemberProfile | null {
    return getProfileEngine(db, publicKey, requesterPubkey);
}

export function getAllProfiles(requesterPubkey?: string): MemberProfile[] {
    return getAllProfilesEngine(db, requesterPubkey);
}

// Who may see a member's contact details: THE rule, shared by the profile page and every list that sends member
// rows (see contactVisibleTo in the engine). A route never decides it itself.
export { contactVisibleTo, publicMemberCard, type ContactViewer };

/** What contactVisibleTo needs to know about the verified signer: member or not, who added them, who they trade with. */
export function contactViewer(viewerPubkey: string | null | undefined): ContactViewer {
    return contactViewerEngine(db, viewerPubkey);
}

/**
 * The act test: a member of this node, a row that exists, isn't a visitor's and isn't pruned, for a key not invalidated
 * by a re-key (the engine's isNodeMember). Suspended and disabled members pass; a visitor's row doesn't (isLiveVisitor
 * says what it may still do). Pass the verified signer.
 */
export function isNodeMember(pubkey: string | null | undefined): boolean {
    return isNodeMemberEngine(db, pubkey);
}

/**
 * A visitor's row that still receives what is sent to it (the engine's isLiveVisitor): it replies in its own direct
 * conversations, sends Beans it holds and reads its own messages and Beans, and nothing else a key with no row can't
 * do. Pass the verified signer.
 */
export function isLiveVisitor(pubkey: string | null | undefined): boolean {
    return isLiveVisitorEngine(db, pubkey);
}

/**
 * The member row `publicKey` acts with here: its row, unless that row is a visitor's (isVisitorKey), which acts as a key
 * with no row does. For a write whose "is there a member" test refuses a key with no row, so that a visitor is refused
 * it in the same words. Pass the verified signer.
 */
export function getActingMember(publicKey: string): Member | undefined {
    const member = getMember(publicKey);
    return member && !isVisitorKey(publicKey) ? member : undefined;
}

/**
 * The read test, for what only members may read: isNodeMember (which a visitor's row fails), and not suspended or
 * disabled (the engine's readsAsMember). Pass the verified signer.
 */
export function readsAsMember(pubkey: string | null | undefined): boolean {
    return readsAsMemberEngine(db, pubkey);
}

/** Passes the gated-read gate: isNodeMember (the engine's passesReadGate). Pass the verified signer. */
export function passesReadGate(pubkey: string | null | undefined): boolean {
    return passesReadGateEngine(db, pubkey);
}

/**
 * May bring someone in (an invite, an offline ticket, an answer to a knock): isNodeMember, for a key in the one spelling
 * (the engine's mayBringSomeoneIn). Pass the verified signer, or the maker a code names.
 */
export function mayBringSomeoneIn(pubkey: string | null | undefined): boolean {
    return mayBringSomeoneInEngine(db, pubkey);
}

/** A visitor's row, not a member's (the engine's isVisitorKey; members.is_visitor). */
export function isVisitorKey(pubkey: string | null | undefined): boolean {
    return isVisitorKeyEngine(db, pubkey);
}

/** Has already joined, for the doors: a member row that isn't a visitor's, or a closed one (the engine's alreadyJoined). */
export function alreadyJoined(pubkey: string | null | undefined): boolean {
    return alreadyJoinedEngine(db, pubkey);
}

/** A key a re-key replaced, pending or completed (the engine's isInvalidatedKey, which ignores case). Pass the verified signer. */
export function isInvalidatedKey(pubkey: string | null | undefined): boolean {
    return isInvalidatedKeyEngine(db, pubkey);
}

/**
 * A key whose account here was closed: its member row is 'pruned', written by a removal (adminPruneUser) or by the
 * member deleting their own account (purgeMemberSelf). Ignores case, as isInvalidatedKey does: the signature check
 * forgives it, and the member table keeps lower-case hex. False for a key with no row. Pass the verified signer.
 */
export function isClosedAccountKey(pubkey: string | null | undefined): boolean {
    if (!pubkey) return false;
    return !!db.prepare("SELECT 1 FROM members WHERE public_key IN (?, ?) AND status = 'pruned'").get(pubkey, pubkey.toLowerCase());
}

export function updateProfile(publicKey: string, update: any): MemberProfile | null {
    return updateProfileEngine(broadcast, publicKey, update);
}

// Per-node callsign availability (case-insensitive). Pure read — re-exported as-is
// for the /api/members/callsign-available endpoint and any caller that needs it.
// findRecoveryCandidates backs /api/recovery/lookup and shares that status predicate.
export { isCallsignAvailable, findRecoveryCandidates };

// ===================== TRUST STATS =====================

/**
 * Calculates trust metrics for a member used by the dynamic credit formula.
 * Excludes escrow system wallets and self-transactions.
 */
export function getMemberTrustStats(publicKey: string): TrustStats {
    return engine.getMemberTrustStats(db, publicKey);
}

export function runWashTradingAnalysis(): WashAnalysis {
    return engine.runWashTradingAnalysis(db);
}

export function getWashTradingEnforcement(): WashAnalysis {
    return engine.getWashTradingEnforcement(db);
}

export function clearWashTradingCache() {
    engine.clearWashTradingCache(db);
}

function qualifiedTradeValue(publicKey: string): number {
    return engine.qualifiedTradeValue(db, publicKey);
}

/**
 * Returns the full trust profile for a member: stats, floor, ceiling, and tier.
 * Incorporates any pre-seeded earned_credit from admin genesis invites.
 */
export function getMemberTrustProfile(publicKey: string): {
    stats: TrustStats;
    floor: number;
    tier: TierInfo;
    earnedCredit: number;
    grantedCredit: number;
    qualifiedValue: number;
    avgRating: number;
    reviewCount: number;
    vouched: boolean;
    activated: boolean;
} {
    return engine.getMemberTrustProfile(db, publicKey);
}

// ===================== TRUST PROFILE (VIEWER-AWARE) =====================

export interface TradeRiskAssessment {
    band: 'green' | 'yellow' | 'red';
    headline: string;
    reasons: string[];
    tips: string[];
}

/**
 * Shared safety verdict used by the Trust Profile and (later) the at-trade
 * accept/confirm gate, so badge / profile / gate all agree. Friction scales
 * with risk: invisible for trusted circles, explicit caution for new+unvouched.
 * See docs/trust-profile-and-trade-safety.md §4.
 */
export function assessTradeRisk(s: {
    tier: TierInfo;
    tradeCount: number;
    completionRate: number | null;
    mutualCount: number;
    priorTradesWithViewer: number;
    wardsCount: number;
    ageDays: number;
}): TradeRiskAssessment {
    const reasons: string[] = [];
    const meetingTips = [
        'Meet somewhere public the first time.',
        "Don't share your home address until you've met.",
        'Tell a friend where and when you\'re meeting.',
    ];

    // Poor completion history is a caution regardless of other signals.
    const poorCompletion = s.completionRate !== null && s.tradeCount >= 4 && s.completionRate < 0.5;

    // 🟢 In your circle — invisible friction.
    if (s.priorTradesWithViewer > 0) {
        reasons.push(`You've completed ${s.priorTradesWithViewer} trade${s.priorTradesWithViewer === 1 ? '' : 's'} with them before.`);
        if (s.mutualCount > 0) reasons.push(`You share ${s.mutualCount} connection${s.mutualCount === 1 ? '' : 's'}.`);
        return { band: 'green', headline: "You've traded together before", reasons, tips: [] };
    }
    if (s.mutualCount >= 1 && !poorCompletion) {
        reasons.push(`You share ${s.mutualCount} connection${s.mutualCount === 1 ? '' : 's'} — someone you know can vouch for them.`);
        if (s.tradeCount > 0) reasons.push(`${s.tradeCount} completed trade${s.tradeCount === 1 ? '' : 's'} on record.`);
        return { band: 'green', headline: 'In your circle', reasons, tips: [] };
    }

    // Established member with a clean record, just no overlap with you yet.
    const established = s.tier.name !== 'Newcomer' && s.tradeCount >= 5
        && (s.completionRate === null || s.completionRate >= 0.8);
    if (established && !poorCompletion) {
        reasons.push(`Established member — ${s.tradeCount} completed trades.`);
        reasons.push('No connections in common with you yet.');
        return { band: 'green', headline: 'Established member', reasons, tips: [] };
    }

    // 🔴 New & unvouched, or a poor track record → explicit caution + tips.
    const brandNew = s.tradeCount === 0 && s.ageDays < 14;
    if (brandNew || poorCompletion) {
        if (poorCompletion) {
            reasons.push(`Only ${Math.round((s.completionRate ?? 0) * 100)}% of their trades completed.`);
        } else {
            reasons.push('New member with no completed trades yet.');
        }
        reasons.push('No connections in common with you.');
        return { band: 'red', headline: 'New & unvouched — take normal precautions', reasons, tips: meetingTips };
    }

    // 🟡 New to you — a real but limited record, no shared connections.
    reasons.push(`${s.tradeCount} completed trade${s.tradeCount === 1 ? '' : 's'} on record.`);
    if (s.completionRate !== null) reasons.push(`${Math.round(s.completionRate * 100)}% completion rate.`);
    reasons.push('No connections in common with you yet.');
    return { band: 'yellow', headline: 'New to you', reasons, tips: [] };
}

/**
 * A member's last-active time as served to anyone but the member themself: the UTC day only.
 *
 * Secret ballots (answer I): the live tally and the per-vote broadcast say WHEN a vote landed, and every
 * signed write stamps last_active_at, so a millisecond timestamp would let anyone match a vote to its voter.
 * A day is still enough to say "active today". The member sees their own exact time. Server-side checks
 * (turnout, lead inactivity) read the column directly and are unaffected.
 */
export function lastActiveForViewer(iso: string | null | undefined, subjectPubkey: string, viewerPubkey?: string | null): string | null {
    if (!iso) return null;
    if (viewerPubkey && viewerPubkey === subjectPubkey) return iso;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    return `${new Date(t).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export interface ViewerTrustProfile {
    publicKey: string;
    callsign: string;
    joinedAt: string | null;
    lastActiveAt: string | null;
    tier: TierInfo;
    earnedCredit: number; // pre-existing: returned by getTrustProfileForViewer but was missing from this interface
    stats: TrustStats; // tradeCount, uniquePartners, ageDays
    completionRate: number | null;
    completedTrades: number;
    cancelledTrades: number;
    wardsCount: number; // how many people trust them as a recovery guardian
    mutualConnections: { publicKey: string; callsign: string; avatarUrl: string | null }[];
    mutualCount: number;
    priorTradesWithViewer: number;
    vouchedInBy: {
        kind: 'member' | 'admin' | 'founder';
        publicKey: string | null; // set only for kind 'member'
        callsign: string | null;  // set only for kind 'member'
        avatarUrl: string | null;
        tier: string | null;
    } | null;
    // Elder endorsement (distinct from vouchedInBy / inviter). Present when an
    // Elder has vouched for this member; lifts the floor-gate for founding members.
    elderVouch: {
        publicKey: string;
        callsign: string;
        avatarUrl: string | null;
    } | null;
    risk: TradeRiskAssessment;
}

/**
 * Assembles the viewer-aware Trust Profile for `targetPubkey` as seen by
 * `viewerPubkey`. Aggregate signals are public; identities are graduated —
 * only mutual connections (people the viewer already knows) are named.
 * See docs/trust-profile-and-trade-safety.md §2.
 */
/**
 * "Vouched in by" — who brought this member in.
 *
 * A peer inviter is returned by name, so invitations carry accountability: bringing someone in
 * puts your name on their profile and makes you a reachable reference if a trade goes wrong. When
 * the inviter is the system admin or a founder there is no peer to reach out to, so the kind says
 * so and `publicKey` is null — the UI shows a clear, non-actionable label rather than a dead link.
 *
 * Shared with the keyholder system (K3), where those null cases are not cosmetic: a member with no
 * human inviter has NOBODY to hold their inviter fragment, and lands at signup with two pieces
 * rather than three. Both callers must agree on who counts as an inviter, so there is one
 * implementation rather than two that drift.
 */
export function resolveVouchedInBy(targetPubkey: string): ViewerTrustProfile['vouchedInBy'] {
    const member = getMember(targetPubkey);
    const inviterKey = member?.invitedBy;
    if (!inviterKey || inviterKey === targetPubkey) return null;

    if (inviterKey === 'genesis') {
        return { kind: 'founder', publicKey: null, callsign: null, avatarUrl: null, tier: null };
    }
    if (inviterKey === 'SYSTEM' || isAdminPubkey(inviterKey)) {
        return { kind: 'admin', publicKey: null, callsign: null, avatarUrl: null, tier: null };
    }
    const inviter = getMember(inviterKey);
    if (!inviter) return null;
    return {
        kind: 'member',
        publicKey: inviterKey,
        callsign: inviter.callsign,
        avatarUrl: avatarUrlFor(inviter.publicKey, inviter.avatarUrl),
        tier: getMemberTrustProfile(inviterKey).tier.name,
    };
}

export function getTrustProfileForViewer(viewerPubkey: string, targetPubkey: string): ViewerTrustProfile | null {
    const member = getMember(targetPubkey);
    if (!member) return null;

    const { stats, tier, earnedCredit } = getMemberTrustProfile(targetPubkey);

    // Completion rate — completed vs cancelled marketplace deals.
    const compRow = db.prepare(`
        SELECT
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
        FROM marketplace_transactions
        WHERE buyer_pubkey = ? OR seller_pubkey = ?
    `).get(targetPubkey, targetPubkey) as any;
    const completedTrades = compRow?.completed || 0;
    const cancelledTrades = compRow?.cancelled || 0;
    const totalResolved = completedTrades + cancelledTrades;
    const completionRate = totalResolved > 0 ? completedTrades / totalResolved : null;

    const wardsCount = 0;

    // Mutual connections: viewer's friends ∩ target's friends. Only ever
    // surfaces people the viewer already knows — never the target's wider graph.
    const mutualConnections = (viewerPubkey && viewerPubkey !== targetPubkey)
        ? (db.prepare(`
            SELECT m.public_key as publicKey, m.callsign, m.avatar_url as avatarUrl
            FROM friends fv
            JOIN friends ft ON fv.friend_pubkey = ft.friend_pubkey
            JOIN members m ON m.public_key = fv.friend_pubkey
            WHERE fv.owner_pubkey = ? AND ft.owner_pubkey = ?
              AND fv.friend_pubkey != ? AND fv.friend_pubkey != ?
            ORDER BY m.callsign COLLATE NOCASE
            LIMIT 12
        `).all(viewerPubkey, targetPubkey, viewerPubkey, targetPubkey) as any[]).map(r => ({
            publicKey: r.publicKey,
            callsign: r.callsign,
            avatarUrl: avatarUrlFor(r.publicKey, r.avatarUrl)
        }))
        : [];
    const mutualCount = mutualConnections.length;

    // Prior direct/marketplace trades between viewer and target.
    let priorTradesWithViewer = 0;
    if (viewerPubkey && viewerPubkey !== targetPubkey) {
        const priorRow = db.prepare(`
            SELECT (
                SELECT COUNT(*) FROM transactions
                WHERE ((from_pubkey = ? AND to_pubkey = ?) OR (from_pubkey = ? AND to_pubkey = ?))
                AND from_pubkey NOT LIKE 'escrow_%' AND to_pubkey NOT LIKE 'escrow_%'
                AND from_pubkey != 'SYSTEM' AND to_pubkey != 'SYSTEM'
            ) + (
                SELECT COUNT(*) FROM marketplace_transactions
                WHERE status = 'completed'
                AND ((buyer_pubkey = ? AND seller_pubkey = ?) OR (buyer_pubkey = ? AND seller_pubkey = ?))
            ) as count
        `).get(viewerPubkey, targetPubkey, targetPubkey, viewerPubkey,
               viewerPubkey, targetPubkey, targetPubkey, viewerPubkey) as any;
        priorTradesWithViewer = priorRow?.count || 0;
    }

    // "Vouched in by" — who brought this member in. A peer inviter is shown by
    // name with a tappable link, so invitations carry accountability: bringing
    // someone in puts your name on their profile and makes you a reachable
    // reference if a trade goes wrong. When the inviter is the system admin or a
    // founder there's no peer to reach out to — show a clear, non-actionable
    // label instead (and never a dead-end tappable link).
    const vouchedInBy = resolveVouchedInBy(targetPubkey);

    const risk = assessTradeRisk({
        tier,
        tradeCount: stats.tradeCount,
        completionRate,
        mutualCount,
        priorTradesWithViewer,
        wardsCount,
        ageDays: stats.ageDays,
    });

    // Elder endorsement badge — who (if anyone) has vouched for this member.
    let elderVouch: ViewerTrustProfile['elderVouch'] = null;
    if (member.elderVouchedBy) {
        const voucher = getMember(member.elderVouchedBy);
        if (voucher) {
            elderVouch = {
                publicKey: voucher.publicKey,
                callsign: voucher.callsign,
                avatarUrl: avatarUrlFor(voucher.publicKey, voucher.avatarUrl),
            };
        }
    }

    return {
        publicKey: targetPubkey,
        callsign: member.callsign,
        joinedAt: member.joinedAt || null,
        lastActiveAt: lastActiveForViewer(member.lastActiveAt, targetPubkey, viewerPubkey),
        tier,
        earnedCredit,
        stats,
        completionRate,
        completedTrades,
        cancelledTrades,
        wardsCount,
        mutualConnections,
        mutualCount,
        priorTradesWithViewer,
        vouchedInBy,
        elderVouch,
        risk,
    };
}

// ===================== LEDGER =====================

export function getBalance(publicKey: string): { balance: number; floor: number; usableFloor: number; liveOffers: number; frozen: boolean; tier: TierInfo; earnedCredit: number; commonsBalance: number; activated: boolean; canVouch: boolean; canOperate: boolean; keeperOf: string[]; isTreasury: boolean; nodeRole: MemberNodeRole | null } {
    const account = ledger.getAccount(publicKey);
    const { floor, tier, earnedCredit, activated } = getMemberTrustProfile(publicKey);
    const balance = Math.round(account.balance * 100) / 100;
    const liveOffers = liveOfferCount(publicKey);
    const isTreasury = !!(db.prepare("SELECT is_treasury FROM members WHERE public_key = ?").get(publicKey) as any)?.is_treasury;
    const effectiveFloor = isTreasury ? getEnterpriseUnderlyingFloor(publicKey).floor : floor;
    const uFloor = usableFloor(publicKey);
    return {
        balance,
        floor: effectiveFloor,
        usableFloor: uFloor,
        liveOffers,
        frozen: balance < uFloor,
        tier,
        earnedCredit,
        commonsBalance: Math.round(COMMONS_BALANCE * 100) / 100,
        // activated: has a credit line at all (earned/vouched/granted) — a brand-new member is false.
        // canVouch: this member holds the appointed-voucher capability (drives the client vouch UI).
        activated,
        canVouch: canVouch(publicKey),
        // canOperate: this member is a keeper of SOMETHING — a coarse "show the steward layer at all"
        // flag. Never gate a specific enterprise's controls on it (#106); use keeperOf below.
        canOperate: canOperate(publicKey),
        // keeperOf: the enterprises this member may actually drive. The Commons tab renders operate
        // controls only on these cards — a control you can't use shouldn't be drawn.
        keeperOf: keeperOf(publicKey),
        // isTreasury: this account IS a community treasury (the Commons' trading face), not a person.
        isTreasury,
        // nodeRole: explicit owner/admin role (docs/admin-surface.md §1, §5; docs/the-commons.md §9.2).
        nodeRole: nodeRoleOf(publicKey),
    };
}

/**
 * A2-1 fix — re-sync the in-memory LedgerManager from the `accounts` table.
 *
 * The in-memory ledger is the source of truth for balance reads + floor checks
 * (getBalance, transfer), and `transfer` writes the in-memory balance back to the
 * DB. Crowdfund pledge/refund paths in db.ts mutate `accounts.balance` with raw
 * SQL OUTSIDE the ledger; without this resync the in-memory ledger goes stale and
 * the next `transfer()` clobbers the DB with the stale (pre-mutation) value,
 * erasing the debit → unbacked credit. Registered as db.ts's balance-mutation
 * hook in initStateEngine so it fires after every such mutation regardless of the
 * caller (route, test, or future code).
 *
 * Reloads only the ledger account balances (mirrors the boot + importRemoteState
 * reloads). COMMONS_BALANCE is deliberately NOT reseeded here: the crowdfund paths
 * never touch the commons pool, and reseeding from the DB could roll back
 * in-memory demurrage not yet persisted.
 */
export function reconcileLedgerFromDb(): void {
    const accounts = db.prepare("SELECT public_key as id, balance, last_demurrage_epoch as lastDemurrageEpoch FROM accounts").all() as any[];
    ledger.loadState(accounts);
}


export function transfer(from: string, to: string, amount: number, memo: string, method?: 'direct' | 'escrow', isFeeExempt = false, auth?: { signer: string; signature?: string; payload?: string; offboardOverride?: boolean }): Transaction | null {
    // Before every other guard: on a node whose `beans` switch is off nothing moves, whoever asks (a member's send,
    // an escrow, a settlement, a wizard's gift). Thrown, not null, so an enclosing transaction rolls back.
    assertBeansOn();
    if (from !== 'genesis' && from !== 'COMMONS_POOL') assertMemberActive(from);
    if (!isSyntheticAccount(to) && to !== 'genesis' && to !== 'COMMONS_POOL') {
        const dest = db.prepare("SELECT status FROM members WHERE public_key = ?").get(to) as any;
        if (dest?.status === 'completed') throw new Error('Enterprise has wound up — account closed');
    }
    if (amount < 0) return null;
    // Only register real members — skip synthetic wallets. Uses the shared predicate so a new synthetic
    // kind is covered automatically; #104's bridge_<peer> accounts were caught by a test failing here
    // (registerVisitor tried to create a member row for a bridge account and hit a UNIQUE violation).
    // Bridge accounts need seeding AND decay-exempting on first touch, which ensureBridgeAccount does
    // together. The upsert below would persist the balance regardless, but the exemption would be missed.
    if (from.startsWith('bridge_')) ensureBridgeAccount(peerFromBridgeAccountId(from)!);
    if (to.startsWith('bridge_')) ensureBridgeAccount(peerFromBridgeAccountId(to)!);

    if (!isSyntheticAccount(from) && !getMember(from)) registerVisitor(from);
    // A recipient with no row here gets a visitor's row, but only once the Beans have moved: in the transaction below,
    // so a send any rule refuses (the send gate, the sender's floor) leaves no row behind.
    const newRecipient = !isSyntheticAccount(to) && !getMember(to);
    // One key, one spelling (engine/member-key.ts): a recipient with no row gets one only under a key written the way
    // this community keeps keys, so Beans sent to a member's key in capitals make no second row that holds them.
    // Thrown before anything moves; the send route refuses it first (400 bad_key).
    if (newRecipient && !isMemberKeySpelling(to)) throw badKeyError();
    // A visitor's row (isLiveVisitor) makes no row for anyone else: it sends Beans only to a key that has a row here.
    // Thrown, as assertNodeMember's refusal, so an enclosing transaction rolls back; the send route answers it.
    if (newRecipient && isLiveVisitor(from)) {
        throw Object.assign(new Error(NOT_A_MEMBER_ERROR), { status: 403, statusCode: 403, code: NOT_A_MEMBER_CODE });
    }

    // Send gate (Trust Model v2): direct peer-to-peer sends ("gift a friend") require the sender
    // to have EARNED trust — i.e. completed at least one real (marketplace) trade. Stops a fresh /
    // farmed account from instantly forwarding received credits and vanishing. Re-keyed off the
    // now-cosmetic tier (canGift) onto value-based earned credit. Escrow/marketplace flows and
    // system accounts (COMMONS_POOL/genesis) are exempt.
    const isEscrow = method === 'escrow' || from.startsWith('escrow_') || to.startsWith('escrow_');
    // #104: a bridge_<peer> account is the local payer when settling a visitor's purchase. It has no
    // trust profile, so the completed-trade gate would block every cross-node settlement.
    // Operator/admin-signed transfers for member offboarding wizard gifts are narrowly exempt via offboardOverride.
    const isOffboardOverride = Boolean(auth?.offboardOverride && auth?.signer && (auth.signer === 'owner:password' || isNodeAdmin(auth.signer) || isNodeOwner(auth.signer)));
    if (!isEscrow && !isOffboardOverride && from !== 'COMMONS_POOL' && from !== 'genesis' && !from.startsWith('bridge_')) {
        const { earnedCredit } = getMemberTrustProfile(from);
        if (earnedCredit <= 0) {
            console.log(`🚫 Send blocked (no completed trade yet): ${from.substring(0, 12)}`);
            return null;
        }
    }

    // (Ghost velocity gate removed — the sliding value-based floor already bounds how much a new
    // account can move, so a daily rate-limit keyed off the now-cosmetic "Newcomer" tier is moot.)

    // Sender's spending limit:
    //  • System wallets (COMMONS_POOL, genesis) — unbounded.
    //  • Escrow wallets (escrow_*) — only what they hold (`ESCROW_FLOOR`, a hair below zero); see below.
    //  • Marketplace / escrow spends — the full earned credit LINE (your floor, may be negative):
    //    the overdraft exists so you can trade for real goods/services, backed by a promise to reciprocate.
    //  • Direct "send credits" gifts — POSITIVE BALANCE ONLY (floor 0). You can only gift beans you
    //    actually hold; you can never go into debt to give beans away.
    // #104: bridge_<peer> is unbounded HERE on purpose — it must be able to go negative, because that
    // negative IS the credit extended to the peer. It is not unbounded in effect: settlementCapacity()
    // bounds it upstream against the operator-set per-peer cap, which is the only place that limit
    // belongs (docs/federation-economics.md Rule 5). A floor here would make settlement impossible.
    //
    // ESCROW IS NOT UNBOUNDED. It used to be lumped in with the other system wallets on the line below
    // and given a `-Infinity` floor, which meant any debit from an escrow succeeded regardless of what
    // the escrow actually held — the bug that let a post removal refund 15 Beans out of two escrows that
    // had never been funded (see `ESCROW_FLOOR` in @beanpool/core for the measurement). An escrow holds
    // beans somebody already paid in; it can only ever pay out what it holds. `ledger.transfer` clamps
    // this again as a primitive, so no caller can re-open the hole by passing its own floor.
    const isUnboundedFrom = from === 'COMMONS_POOL' || from === 'genesis' || from.startsWith('bridge_');
    const senderFloor = isEscrowAccount(from) ? ESCROW_FLOOR
        : isUnboundedFrom ? -Infinity
        : isEscrow ? usableFloor(from)   // v3: marketplace spends bounded by the offer-banded floor
        : 0;
    // Fee policy: the 1.5% community fee applies ONLY to marketplace/escrow settlements. Direct
    // peer "send credits" gifts are fee-free — gifting a friend beans you hold shouldn't be taxed.
    // System moves (escrow holds, refunds, admin) stay exempt via the caller's isFeeExempt.
    const feeExempt = isFeeExempt || !isEscrow;

    // ATOMICITY (money). Everything from the in-memory `ledger.transfer` through the last persisted row is
    // ONE unit. It used to be five autocommitted statements, and every gap between them was a way to destroy
    // beans on disk: a crash after the sender's row was written but before the recipient's left the debit
    // durable with no matching credit, and boot rebuilds memory from those rows (`initStateEngine`). The
    // other gaps are the same shape — history written with no balance moved, or balances moved with the
    // decay rows that justify them missing. `runLedgerAudit` only WARNS on the resulting drift, and
    // `reconcileLedgerFromDb` faithfully reloads whichever torn state the crash left.
    //
    // It must be `conservingTransaction`, NOT a bare `db.transaction`: the in-memory mutation is inside the
    // block, and a bare transaction rolls back only the rows — leaving memory ahead of the DB, which is the
    // hazard that wrapper's docblock describes at length.
    //
    // Every other caller already runs transfer() inside a conservingTransaction of its own (escrow,
    // settlement, wizards, admin deletes), so for them this is a SAVEPOINT nested in their transaction and
    // the outer commit is still what makes anything durable. The two callers that did NOT wrap — the
    // member-to-member send route and `migrateEscrowWalletKeys` — are the ones this closes.
    const txn = conservingTransaction<Transaction | null>(() => {
        const success = ledger.transfer(from, to, amount, senderFloor, feeExempt);
        if (!success) return null;
        // The rows only: ledger.transfer has just made the in-memory account it credited, and persistAccount below
        // writes its balance over the row's 0.
        if (newRecipient) writeVisitorRow(to);

        if (!isSyntheticAccount(from) && from !== 'genesis') {
            recordActivity(from);
        }

        const taxFee = feeExempt ? 0 : amount * TRANSACTION_FEE_RATE;

        const built: Transaction = {
            id: crypto.randomUUID(),
            from, to, amount,
            taxFee,
            memo: memo || '',
            timestamp: new Date().toISOString(),
        };
        if (amount > 0) {
            // SRV-20: persist the caller's request signature (if supplied) so this
            // transaction's authorship is re-verifiable on import. NULL for
            // system/internal transfers (those become node-signed in a later step).
            db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp, auth_signer, auth_signature, auth_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                built.id, built.from, built.to, built.amount, built.taxFee, built.memo, built.timestamp,
                auth?.signer ?? null, auth?.signature ?? null, auth?.payload ?? null,
            );
        }

        // Sync ledger account balances to DB
        const fromAcc = ledger.getAccount(from);
        const toAcc = ledger.getAccount(to);
        // UPSERT, not UPDATE. ledger.getAccount() auto-creates an account in memory on first touch, but a
        // bare `UPDATE ... WHERE public_key=?` matches 0 rows when SQLite has never seen it — silently, so
        // the in-memory balance and the DB diverge permanently and every later read returns 0. Synthetic
        // accounts are the exposed case, since transfer() skips registerVisitor() for them: escrow_* happens
        // to be safe only because escrow.ts INSERT OR IGNOREs first. This closes the class rather than one
        // instance of it.
        const persistAccount = db.prepare(`
            INSERT INTO accounts (public_key, balance, last_demurrage_epoch, last_updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(public_key) DO UPDATE SET
                balance = excluded.balance,
                last_demurrage_epoch = excluded.last_demurrage_epoch,
                last_updated_at = excluded.last_updated_at
        `);
        const nowIso = new Date().toISOString();
        persistAccount.run(from, fromAcc.balance, fromAcc.lastDemurrageEpoch, nowIso);
        persistAccount.run(to, toAcc.balance, toAcc.lastDemurrageEpoch, nowIso);

        // Persist demurrage decay rows + commons balance (transfers trigger decay on both accounts)
        persistDecayEvents();
        persistCommonsBalance();

        return built;
    });
    // A refused transfer (over the sender's floor) is not a failure to roll back — nothing was written, so
    // the empty transaction commits and we return null exactly as before.
    if (!txn) return null;

    afterTransactionCommit(() => {
        const toMember = getMember(to);
        if (toMember?.isTreasury) {
            sweepEnterpriseCeiling(to);
        }
    });

    const fromMember = getMember(from);
    const toMember = getMember(to);
    broadcast({
        type: 'transaction',
        txn: { ...txn, fromCallsign: fromMember?.callsign || 'Unknown', toCallsign: toMember?.callsign || 'Unknown' },
    }, [from, to]); // A2-20: a transfer is visible only to its two parties on the live feed
    return txn;
}

/**
 * Close the demurrage window on these accounts and make it DURABLE. Call this immediately before any path
 * that RAISES a balance without going through `transfer()` / `payFromCommons()`.
 *
 * WHY (#138). Demurrage is principal × time × rate, so an interval cannot be carried across a change of
 * principal. If an account's stored `last_demurrage_epoch` is stale and its balance then increases with the
 * window left open, the account's next read charges the WHOLE old interval against the new, larger balance.
 * Measured at the core level: an account holding 200.005 with a 60-day open window that receives 10,000 is
 * charged 465.33 beans — 4.6% of the deposit, instantly, for time during which it held almost nothing.
 *
 * This does not merely stamp the epoch — it SETTLES. `ledger.getAccount()` charges what the old principal
 * genuinely owes (debiting the account, crediting the Commons, queueing an event), and the epoch is stamped
 * on every branch of `applyDecay`, including the ones that collect nothing. So the value that was owed is
 * still collected; only the retrospective over-charge goes away.
 *
 * WHY IT WRITES THE ROW ITSELF rather than leaning on `persistDecayEvents()`. That function returns early
 * when the queue is empty, and the queue is empty in exactly the cases that matter most: a balance inside
 * the tax-free Green Zone, a decay too small to record, and a decay forfeited at the pending-events cap all
 * stamp the epoch in memory and queue nothing. The stale epoch would then survive in the row, the raw-SQL
 * credit would land on top of it, and the balance-mutation hook would reload the stale pair straight back
 * into memory — the bug, intact, in the quietest cases. So every named account's epoch is persisted here
 * whether or not it produced an event.
 *
 * Call it OUTSIDE any surrounding `db.transaction` — it opens its own, and settling is independently correct:
 * it must not be undone by an unrelated later failure in a caller's transaction.
 *
 * ON THE PAYER SIDE TOO, where a path is already settling (review finding). A balance that merely FALLS under
 * an open window only under-collects, which is the safe direction, so this is not swept across every debit
 * path. But an affordability check reading a pre-decay row lets a member spend beans demurrage has already
 * taken, and that is not a direction question — `pledgeToProject` settles both the creator and the backer for
 * exactly that reason.
 */
export function settleDemurrage(publicKeys: string[]): void {
    // De-duplicated: a refund run can name the same backer twice, and when a project's creator pledges to
    // their own project both names are the same account.
    const accountIds = Array.from(new Set(publicKeys)).filter(Boolean);
    if (accountIds.length === 0) return;

    const persistAccount = db.prepare(`
        INSERT INTO accounts (public_key, balance, last_demurrage_epoch, last_updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(public_key) DO UPDATE SET
            balance = excluded.balance,
            last_demurrage_epoch = excluded.last_demurrage_epoch,
            last_updated_at = excluded.last_updated_at
    `);
    const nowIso = new Date().toISOString();

    // ONE transaction, not one per account (review finding). A refund settles every backer of a project, so
    // an un-batched loop is a separate WAL commit per member. Atomicity is the better half of the argument
    // though: a failure partway through left some windows closed and some open, with the decay applied in
    // memory for every one of them.
    //
    // `conservingTransaction`, not a bare `db.transaction`, because the work here is half in memory —
    // `getAccount()` debits the account and credits `COMMONS_BALANCE`, neither of which a SQLite rollback
    // touches. Without the resync a rollback would leave memory holding decay that no row records.
    //
    // Both persists are INSIDE. `persistCommonsBalance()` is what makes the credit durable, so committing the
    // account debits without it would mean a restart restoring the pot from its pre-decay row: debits durable,
    // matching credit gone, beans destroyed.
    conservingTransaction(() => {
        for (const publicKey of accountIds) {
            const account = ledger.getAccount(publicKey);   // applies + queues any decay, and stamps the epoch
            persistAccount.run(publicKey, account.balance, account.lastDemurrageEpoch, nowIso);
        }
        persistDecayEvents();
        persistCommonsBalance();
    });
}

/**
 * Run ledger writes in a DB transaction that also unwinds the IN-MEMORY ledger on failure.
 *
 * `transfer()`, `moveToCommons()` and `payFromCommons()` mutate two things: the SQLite rows, and the
 * in-memory `ledger` (account balances plus the `COMMONS_BALANCE` global). `db.transaction()` rolls back
 * only the SQLite half. So if any later statement in the same transaction throws, the rows revert and
 * memory keeps the mutation — the two disagree permanently, until a restart, with every subsequent read
 * served from the wrong number. Worse, the next `persistCommonsBalance()` writes the stale global back over
 * the rolled-back row, turning a clean rollback into a durable overstatement of the Commons.
 *
 * `reconcileLedgerFromDb()` rebuilds in-memory ACCOUNT balances from the rows, which after a rollback are
 * the truth. It deliberately does NOT reseed `COMMONS_BALANCE` (the crowdfund paths own that global), so the
 * pot is snapshotted and restored separately. Both halves, or neither is any use — a review finding against
 * an earlier version of this wrapper was that it resynced accounts and left the Commons global ahead of
 * the DB, which is the more damaging half.
 *
 * WHY IT FLUSHES DECAY FIRST (review finding, and the subtle one). Demurrage is applied LAZILY inside
 * `ledger.getAccount()`: it debits the account and does `COMMONS_BALANCE += decayed` in memory, queues a
 * decay event, and touches no row until `persistDecayEvents()` runs. If that has happened but not yet been
 * flushed when the snapshot is taken, the snapshot contains a Commons credit whose matching account debit
 * exists only in memory. A rollback then reloads the PRE-decay account row and `loadState()` clears the
 * decay queue (ledger.ts) — so restoring the snapshotted Commons keeps a credit with no debit anywhere, and
 * the next flush mints it. Flushing first makes memory and rows agree before there is anything to restore,
 * which is the only version of this wrapper that is safe to use.
 *
 * AND THE PRE-FLUSH IS ITSELF ONE COMMIT (deciding-pass finding). `persistDecayEvents()` opens its own
 * `db.transaction`, so when this is the OUTERMOST caller — a bare `transfer()` from the member-to-member
 * send route — flushing it alone AUTOCOMMITTED the account debits and the `Circulation fee` rows, while the
 * matching Commons credit was only written by `persistCommonsBalance()` inside the block. Consistent, but
 * not durable: a crash in that gap left the debit on disk with its credit gone, and boot restores the pot
 * from the stale `COMMONS_POOL` row. Measured at 208.5825 Beans destroyed on one 5,000-bean account 60 days
 * stale, with the decay queued by nothing more exotic than a `getBalance()` before the send. Both halves now
 * go in one transaction, so the snapshot pair is durable as well as consistent.
 *
 * If THAT flush fails, memory has to be resynced before rethrowing: `drainDecayEvents()` has already emptied
 * the queue, so a rolled-back flush would leave memory holding decay that no row records — the account debit
 * reverted, its Commons credit still in the global, which is the minting direction. The restore point is the
 * ROWS, both halves: accounts pre-decay, and the pot from the `COMMONS_POOL` row. A snapshot of the global
 * taken on entry is no use here and was measured wrong — the decay credit is already in it, because the
 * `getBalance()` that queued the decay ran before this function was ever called.
 *
 * NESTING. `transfer()` now wraps its own writes in this, so every caller that already held a
 * `conservingTransaction` (escrow, settlement, the wizards, admin deletes) nests one inside it, and the
 * inner call becomes a SAVEPOINT. That is safe, but ONLY because the pre-flush above is unconditional.
 *
 * It used to be skipped when nested (`if (!db.inTransaction)`), on the reasoning that the pre-flush
 * commits and nesting would put that commit at risk of the outer rollback. Measured, that reasoning cost
 * beans. Lazy demurrage applied between the outer BEGIN and the inner call sits queued and unflushed: the
 * account's debit is in memory only, the Commons credit is in the global, and `commonsBefore` snapshots the
 * credit. The inner block's own `persistDecayEvents()` then drains the queue and writes the debit INSIDE
 * the savepoint, so a later throw rolls the debit back, leaves the queue empty for `loadState` to unwind,
 * and `setCommonsBalance(commonsBefore)` restores a Commons credit with no debit anywhere. A probe against
 * a 5,000-bean account 60 days stale minted **208.58 beans** on one failed send.
 *
 * Flushing unconditionally makes the pair consistent at every level. When nested, the flush is a savepoint
 * inside the OUTER transaction, opened and released before this call's own savepoint — so an inner rollback
 * keeps it, and `reconcileLedgerFromDb` reads rows that already carry the debit. If the outer later rolls
 * back too, both halves of the flush go with it and the outer's own catch restores its own (earlier)
 * snapshot over the top, which is consistent as well; the only cost is that the decay is recomputed on the
 * next read, which is exactly what `loadState`'s docblock says happens anyway.
 *
 * Lives here rather than beside a caller because the hazard belongs to the primitives, not to any one
 * feature: #104's settlement writes, `adminPruneUser` and the treasury sweep hit it identically, and
 * anything else that composes several ledger moves under one transaction will too.
 */
export function conservingTransaction<T>(fn: () => T): T {
    // Make the rows agree with memory BEFORE snapshotting, so the snapshot is a consistent pair — and a
    // DURABLE one: the decay debits and the Commons credit land in the same commit, or neither does.
    // Unconditional, including when nested — see NESTING above; skipping it here minted beans.
    try {
        persistDecayAndCommons();
    } catch (e) {
        // The flush rolled back, but the queue it drained is gone from memory, so memory now holds decay no
        // row records. Restore BOTH halves from the rows — `null` means "take the pot from its row too",
        // which is the whole point here and not what the failure path below wants. See the docblock.
        resyncMemoryToRows(null, e);
        throw e;
    }
    const commonsBefore = getCommonsBalanceExact();
    try {
        return db.transaction(fn)();
    } catch (e) {
        // The DB has rolled back; resync memory to it rather than leaving the two disagreeing.
        resyncMemoryToRows(commonsBefore, e);
        throw e;
    }
}

/**
 * Put the in-memory ledger back to what the rows say, or halt.
 *
 * Shared by both of `conservingTransaction`'s failure paths because they need almost the same thing:
 * accounts rebuilt from the rows, and the Commons global — which `reconcileLedgerFromDb` deliberately does
 * not touch — put back alongside them.
 *
 * They differ only in WHERE the pot comes from, which is why it is a parameter rather than assumed. After
 * the block fails, the snapshot taken once the pre-flush had made rows and memory agree is the restore
 * point. After the PRE-FLUSH itself fails there is no such snapshot — the global already carries the decay
 * credit whose debit just rolled back — so `null` says to read the `COMMONS_POOL` row, which is the pot as
 * a restart would load it and the only half that matches the accounts being reloaded.
 *
 * The row read is inside the try on purpose: if SQLite is failing badly enough to break it, that is the
 * halt case below, not an exception thrown out of a catch block.
 */
function resyncMemoryToRows(commonsSnapshot: number | null, cause: unknown): void {
    try {
        reconcileLedgerFromDb();
        if (commonsSnapshot !== null) {
            setCommonsBalance(commonsSnapshot);
        } else {
            const row = db.prepare("SELECT balance FROM accounts WHERE public_key = 'COMMONS_POOL'").get() as any;
            if (row && typeof row.balance === 'number') setCommonsBalance(row.balance);
        }
    } catch (resyncError: any) {
        // Unrecoverable: memory and rows now disagree with no way to reconcile them, and every later
        // read would be served from the wrong number — a mutual-credit ledger silently minting is worse
        // than an outage. Halting is also self-healing here: the fleet runs under a restart policy, and
        // boot rebuilds the ledger from the rows, which are the truth after a rollback.
        //
        // Genuinely pathological rather than transient. This is a plain SELECT, the database is in WAL
        // mode, and WAL readers do not block on writers — so a failure here means SQLite itself is
        // failing, not that something held a lock.
        console.error('[Ledger] FATAL: resync after a failed write FAILED. Halting to protect ledger '
            + 'consistency — restart rebuilds from the rows.', resyncError?.message || resyncError);
        console.error('[Ledger] The write that triggered it:', (cause as any)?.message || cause);
        process.exit(1);
    }
}

/**
 * Move value from a SYNTHETIC account into the Commons pot, and record it.
 *
 * `transfer(x, 'COMMONS_POOL', n)` does NOT do this, and the difference is not cosmetic. The Commons pot
 * is the `COMMONS_BALANCE` global; the `COMMONS_POOL` account row is only its persisted shadow, rewritten
 * from the global by `persistCommonsBalance()` after every transfer. So a transfer INTO that account is
 * persisted and then overwritten a moment later, and the value is gone from the node's books at the next
 * restart — the books stop summing to zero, quietly.
 *
 * WHO MAY SEND. Synthetic accounts (escrow_*, bridge_*, project_*) and community TREASURIES. Ordinary
 * member-facing debits belong in `transfer()`, where the send gate, floor policy and fee policy live; this
 * is a plumbing move for value already held in a community-owned account and it implements none of those.
 *
 * A treasury is a member row with `is_treasury = 1`, so it is not synthetic — but a treasury sweeping its
 * own surplus into the shared Commons is a community bookkeeping move, not a peer-to-peer gift, and routing
 * it through `transfer()` was what destroyed the beans (#126). It also means the sweep is no longer subject
 * to the completed-trade send gate, which had been refusing sweeps from treasuries that had never traded
 * with a bare "Sweep failed".
 *
 * FLOOR. An escrow may pay out only what it holds (`ESCROW_FLOOR`, a hair below zero): it drains to zero by
 * design, and paying out more would mint beans. The other synthetic senders are unbounded — a bridge must be
 * able to go negative, because that negative IS the extended credit. A treasury, or a member debited under
 * `allowMemberDebit`, is floored at 0: it may only move what it actually holds, and must never be driven
 * into debt by this path.
 *
 * #104 uses it for the cross-node fee, which the buyer pays on top of the price (§2.1) and which lands in
 * the buyer node's own Commons because that is the node carrying the write-off if the buyer is ever pruned.
 */
export function moveToCommons(
    from: string,
    amount: number,
    memo: string,
    // `allowMemberDebit` opts an ORDINARY member's account into this path, and exists for exactly one
    // caller: `adminPruneUser` confiscating a departing member's surplus so the network still sums to zero.
    //
    // It is an explicit flag rather than a relaxed guard because the guard's whole job is to stop this
    // becoming a back door around `transfer()`'s send gate and floor policy. A prune is different in kind —
    // an admin action on a member being removed, taking a positive balance to exactly zero — so the gate is
    // moot rather than bypassed. Anything else moving a member's value belongs in `transfer()`.
    opts?: { allowMemberDebit?: boolean; authSigner?: string },
): Transaction | null {
    const synthetic = isSyntheticAccount(from);
    const treasury = !synthetic
        && (db.prepare('SELECT is_treasury FROM members WHERE public_key = ?').get(from) as any)?.is_treasury === 1;
    if (!synthetic && !treasury && !opts?.allowMemberDebit) {
        throw new Error(`moveToCommons is for synthetic accounts and treasuries only, got ${from}`);
    }
    if (amount <= 0) return null;
    assertBeansOn();

    return conservingTransaction(() => {
        // A bridge must be able to go negative (that negative IS the credit extended to a peer), so the
        // other synthetic senders stay unbounded. An ESCROW does not: it drains to zero by design, and
        // "by design" has to be enforced rather than assumed — #104 moves the cross-node fee to the
        // Commons straight out of the settlement's escrow account through this very path.
        // A treasury or a member is floored at 0 — neither may be driven into debt by this path.
        const fromFloor = isEscrowAccount(from) ? ESCROW_FLOOR : synthetic ? -Infinity : 0;
        if (!ledger.moveToCommons(from, amount, fromFloor)) return null;

        const txn: Transaction = {
            id: crypto.randomUUID(),
            from, to: 'COMMONS_POOL', amount, taxFee: 0,
            memo: memo || '', timestamp: new Date().toISOString(),
            authSigner: opts?.authSigner ?? null,
        };
        db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp, auth_signer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
            txn.id, txn.from, txn.to, txn.amount, 0, txn.memo, txn.timestamp, opts?.authSigner ?? null
        );

        const fromAcc = ledger.getAccount(from);
        db.prepare(`
            INSERT INTO accounts (public_key, balance, last_demurrage_epoch, last_updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(public_key) DO UPDATE SET
                balance = excluded.balance,
                last_demurrage_epoch = excluded.last_demurrage_epoch,
                last_updated_at = excluded.last_updated_at
        `).run(from, fromAcc.balance, fromAcc.lastDemurrageEpoch, txn.timestamp);

        persistDecayEvents();
        persistCommonsBalance();   // must come last — it is what makes the credit durable
        return txn;
    });
}

/**
 * Pay a member OUT of the Commons pot, and record it. The mirror of `moveToCommons`.
 *
 * Same reasoning: `transfer('COMMONS_POOL', x, n)` moves the shadow account (pushing it negative, funded
 * from nowhere) rather than drawing on the pot, so the draw has to go through `deductFromCommons`. Returns
 * null if the pot cannot cover it — the Commons never goes into debt.
 */
export function payFromCommons(
    to: string,
    amount: number,
    memo: string,
    // `allowDeficit` lets the pot go NEGATIVE rather than refusing. Needed wherever refusing would be worse
    // than a visible deficit — a reversal that can't refund a fee would otherwise strand the whole purchase,
    // and docs/commons-pool-transparency.md's Solvency Rule requires a prune to always balance the books.
    // A negative Commons is the honest record of a community that has paid out more than it has collected;
    // the network still sums to zero, which is the invariant that matters.
    // `authSigner` records the admin who authorised the payment on the row's audit column, as `moveToCommons`
    // does; the memo names them in words only (adminActorName).
    opts?: { allowDeficit?: boolean; authSigner?: string },
): Transaction | null {
    if (amount <= 0) return null;
    assertBeansOn();
    if (!ledger.deductFromCommons(amount)) {
        if (!opts?.allowDeficit) return null;
        setCommonsBalance(getCommonsBalanceExact() - amount);
        console.warn(`[Commons] Paid ${amount} with an insufficient pot — the Commons is now in deficit. Memo: ${memo}`);
    }

    const toAcc = ledger.getAccount(to);
    toAcc.balance += amount;

    const txn: Transaction = {
        id: crypto.randomUUID(),
        from: 'COMMONS_POOL', to, amount, taxFee: 0,
        memo: memo || '', timestamp: new Date().toISOString(),
        authSigner: opts?.authSigner ?? null,
    };
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp, auth_signer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(txn.id, txn.from, txn.to, txn.amount, 0, txn.memo, txn.timestamp, opts?.authSigner ?? null);
    db.prepare(`
        INSERT INTO accounts (public_key, balance, last_demurrage_epoch, last_updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(public_key) DO UPDATE SET
            balance = excluded.balance,
            last_demurrage_epoch = excluded.last_demurrage_epoch,
            last_updated_at = excluded.last_updated_at
    `).run(to, toAcc.balance, toAcc.lastDemurrageEpoch, txn.timestamp);

    // ledger.getAccount(to) above applies any pending demurrage, which queues decay events. Without this
    // they are stranded and the transactions table drifts from account balances — `moveToCommons` persists
    // them and this must too (review finding).
    //
    // ONE commit for the PAIR: the decay debits and the Commons credit that matches them are never allowed
    // to land separately, or a crash between them destroys beans on disk.
    //
    // NOT THE WHOLE FUNCTION, and the gap that leaves is real rather than theoretical. The history row and
    // the recipient's account row above are still separate autocommits, so a crash after the recipient is
    // credited but before `persistCommonsBalance` writes the drawn-down pot leaves the credit durable with
    // the pot's debit missing — beans MINTED, the opposite direction to the pair's failure and the one this
    // function is exposed to. Every caller but one already runs inside a `conservingTransaction`
    // (`adminPruneUser`, the settlement reversals via `settlementTransaction`), which closes it for them;
    // `fundCommission` (federation-commission.ts) does not. Wrapping this function changes rollback
    // semantics for all of them, so it is a deliberate follow-up rather than something to smuggle in here.
    persistDecayAndCommons();

    afterTransactionCommit(() => {
        const toMember = getMember(to);
        if (toMember?.isTreasury) {
            sweepEnterpriseCeiling(to);
        }
    });

    return txn;
}

export function getTransactions(publicKey?: string, limit = 50, offset = 0): Transaction[] {
    let rows;
    if (publicKey) {
        rows = db.prepare(`SELECT * FROM transactions WHERE from_pubkey=? OR to_pubkey=? ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(publicKey, publicKey, limit, offset) as any[];
    } else {
        rows = db.prepare(`SELECT * FROM transactions ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(limit, offset) as any[];
    }
    return rows.map(r => ({ id: r.id, from: r.from_pubkey, to: r.to_pubkey, amount: r.amount, taxFee: r.tax_fee || 0, memo: r.memo, timestamp: r.timestamp }));
}
// ===================== MARKETPLACE =====================

// A local `rowToPost` used to live here. It was a stale duplicate of the one in @beanpool/engine — dead
// since getPosts started delegating (`getPostsEngine`), and never updated for `cash_also_needed`, `reach` or
// `reach_peers`. Removed rather than left as a trap: the next person to need a row mapper would have found
// this one first, and a listing mapped through it would silently lose the poster's reach choice.

// Server-side photo limits. Clients resize to ≤800px JPEG at 0.7 quality, which lands
// well under this cap — anything bigger is a misbehaving or hostile client. Photos are
// stored as base64 in SQLite and replicate to every mirror, so the cap matters.
const MAX_POST_PHOTOS = 5;
const MAX_PHOTO_BASE64_CHARS = 600_000; // ≈ 440 KB of binary image data

function validatePostPhotos(photos: string[] | undefined): void {
    if (photos === undefined) return;
    if (!Array.isArray(photos)) throw new Error('photos must be an array');
    if (photos.length > MAX_POST_PHOTOS) throw new Error(`A post can have at most ${MAX_POST_PHOTOS} photos`);
    for (const p of photos) {
        if (typeof p !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(p)) {
            throw new Error('Each photo must be a base64 data URL (JPEG, PNG, or WebP)');
        }
        if (p.length > MAX_PHOTO_BASE64_CHARS) {
            throw new Error('Photo too large — resize to 800px JPEG before uploading');
        }
    }
}

// Contribution-first gate (Gate 1). Stable prefix so clients can detect this
// specific rejection and show the "list an Offer" prompt instead of a raw error.
export { CONTRIBUTION_REQUIRED_ERROR, COVENANT_REQUIRED_ERROR };

// Offer covenant — BANDED (Trust Model v3). How deep you may spend on credit scales with how many
// LIVE offers you keep posted (see docs/trust-model-v3.md §3-4). Superset of the flat covenant
// above: 0 offers → no credit; 1→−200, 2→−500, 3→−1000, 4→−1500, 5→−2000. Stable prefix so clients
// can detect it and show the ladder / "post another Offer" prompt with the exact numbers.
export const FLOOR_LOCKED_PREFIX = 'FLOOR_LOCKED';
function floorLockedError(publicKey: string, postBalance: number): Error {
    const live = liveOfferCount(publicKey);
    const need = offersRequiredForDepth(Math.abs(postBalance));
    const more = Math.max(1, need - live);
    const unlockedAt = offerCapForCount(live);
    const wouldReach = offerCapForCount(need);
    // Machine-parseable prefix + fields, then a human sentence the client can also show verbatim.
    return new Error(
        `${FLOOR_LOCKED_PREFIX}:${live}:${need}:${unlockedAt}:${wouldReach}: ` +
        (live === 0
            ? `Post an Offer to open your credit line — your first Offer lets you spend down to −200.`
            : `Your ${live} active Offer${live === 1 ? '' : 's'} unlock a −${unlockedAt} credit line. ` +
              `Post ${more} more Offer${more === 1 ? '' : 's'} to spend down to −${wouldReach}.`)
    );
}

/**
 * Has this member ever listed an Offer? Founding members must contribute an
 * Offer of their own before they can post Needs or accept/request Offers.
 * Live-derived (mirrors the authorFoundingNeeded style); removePost soft-deletes,
 * so a once-listed Offer's row persists and still counts ("listed once, ever").
 * The system admin is exempt — it acts at the system level, not as a participant.
 */
export function hasListedOffer(publicKey: string): boolean {
    if (isAdminPubkey(publicKey)) return true;
    return hasListedOfferEngine(db, publicKey);
}

export function hasLiveOffer(publicKey: string): boolean {
    if (isAdminPubkey(publicKey)) return true;
    return hasLiveOfferEngine(db, publicKey);
}

export function liveOfferCount(publicKey: string): number {
    if (isAdminPubkey(publicKey)) return OFFER_BANDS.length - 1;
    return liveOfferCountEngine(db, publicKey);
}

/**
 * Computes an enterprise's underlying credit floor based on keeper backing pledges
 * (docs/the-commons.md §2.6) and its own trust profile (earned/granted credit).
 */
export function getEnterpriseUnderlyingFloor(enterprisePubkey: string): { floor: number; totalBacking: number; hasBacking: boolean } {
    const backingRow = db.prepare(`
        SELECT COALESCE(SUM(o.backing), 0) as totalBacking,
               COUNT(CASE WHEN o.backing > 0 THEN 1 END) as hasBacking,
               COUNT(*) as totalKeepers
        FROM treasury_operators o
        JOIN members m ON m.public_key = o.member_pubkey
        WHERE o.treasury_pubkey = ?
          AND m.status = 'active' AND COALESCE(m.credit_frozen, 0) = 0
    `).get(enterprisePubkey) as any;
    const pledgeRow = db.prepare(`
        SELECT COALESCE(SUM(p.amount), 0) as total
        FROM enterprise_pledges p
        JOIN members m ON m.public_key = p.keeper
        WHERE p.enterprise = ? AND p.released_at IS NULL
          AND m.status = 'active' AND COALESCE(m.credit_frozen, 0) = 0
    `).get(enterprisePubkey) as any;
    const pledgeBacking = Number(pledgeRow?.total || 0);
    const operatorBacking = backingRow?.totalBacking != null ? Number(backingRow.totalBacking) : 0;
    const totalBacking = Math.max(operatorBacking, pledgeBacking);
    const hasExplicitBacking = (backingRow?.hasBacking ?? 0) > 0 || pledgeBacking > 0;

    const memberRow = db.prepare("SELECT earned_credit, legacy_credit_floor, status, COALESCE(credit_frozen, 0) as credit_frozen FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (memberRow?.status === 'completed' || memberRow?.credit_frozen === 1) {
        return { floor: 0, totalBacking: 0, hasBacking: false };
    }

    const memberEarnedCredit = Number(memberRow?.earned_credit || 0);
    let legacyFloor = Number(memberRow?.legacy_credit_floor || 0);
    if (legacyFloor > 0 && totalBacking >= legacyFloor) {
        legacyFloor = 0;
    }

    const effectiveAllowance = Math.max(legacyFloor, totalBacking + memberEarnedCredit);
    if (hasExplicitBacking || legacyFloor > 0 || memberEarnedCredit > 0) {
        const allowance = Math.min(PROTOCOL_CONSTANTS.CREDIT_FLOOR_CAP, effectiveAllowance);
        return { floor: -allowance, totalBacking, hasBacking: hasExplicitBacking || legacyFloor > 0 };
    }

    return { floor: 0, totalBacking: 0, hasBacking: false };
}

export function usableFloor(publicKey: string): number {
    const m = db.prepare("SELECT is_treasury, paused, paused_at, paused_floor_snapshot, status FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!m?.is_treasury) {
        const { floor } = getMemberTrustProfile(publicKey);
        return Math.max(floor, -offerCapForCount(liveOfferCount(publicKey)));
    }

    if (m.status === 'completed') return 0;

    const { floor: underlyingFloor } = getEnterpriseUnderlyingFloor(publicKey);
    const underlyingAllowance = Math.abs(underlyingFloor);
    const liveOffers = liveOfferCount(publicKey);
    const covenantAllowance = offerCapForCount(liveOffers);
    const normalDerivedAllowance = Math.min(underlyingAllowance, covenantAllowance);

    // If enterprise is paused (docs/the-commons.md §2.2):
    if (m.paused === 1 && m.paused_floor_snapshot != null) {
        const pausedAt = m.paused_at ? new Date(m.paused_at).getTime() : Date.now();
        const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
        const isExpired = (Date.now() - pausedAt) > ninetyDaysMs;

        if (!isExpired) {
            const snapshotAllowance = Math.abs(Number(m.paused_floor_snapshot));
            // While paused (up to 90 days):
            // - Covenant floor can never pull it below snapshot (even with 0 offers).
            // - Earned growth still counts (if earned credit raises the floor, use the higher value).
            // - Keeper exits still release backing (if backing is removed, floor drops accordingly).
            // Formula: max(snapshot, derived) where snapshot expires at 90 days. Keeper backing release overrides snapshot floor.
            const effectiveAllowance = underlyingAllowance < snapshotAllowance
                ? underlyingAllowance  // backing withdrawn — override snapshot
                : Math.max(snapshotAllowance, underlyingAllowance);  // earned growth raises it
            return -Math.max(effectiveAllowance, normalDerivedAllowance);
        }
    }

    return -normalDerivedAllowance;
}

/**
 * Does this member hold the vouch capability (the "appointed voucher" / super-Elder)?
 * Handing out the -20 credit floor is the one Sybil-critical power, so it is NOT derived
 * from Elder *tier* (an earned cosmetic badge — grinding to Elder must not confer the power
 * to mint floors for a sock army). It is an explicit, admin-granted flag (members.can_vouch,
 * set via adminSetVoucher), plus the system admin who always holds it.
 */
export function canVouch(publicKey: string): boolean {
    if (isAdminPubkey(publicKey)) return true;
    const row = db.prepare("SELECT can_vouch FROM members WHERE public_key = ?").get(publicKey) as any;
    return !!row?.can_vouch;
}

/**
 * Does this member hold the treasury operator capability AT ALL — i.e. may they steward *something*?
 * This is the coarse prerequisite (members.can_operate, set via adminSetOperator), plus the system
 * admin who always holds it.
 *
 * ⚠️ This is NOT an authorisation check. It answers "is this person a keeper?", never "may they
 * drive THIS enterprise?" — use canOperateTreasury() for that. Before #106 the two questions had the
 * same answer, which is exactly the bug: granting someone the egg flock also handed them every other
 * treasury on the node.
 *
 * Distinct from the 'Steward' tier (a cosmetic badge) and from node role (replication topology).
 */
export function canOperate(publicKey: string): boolean {
    if (isAdminPubkey(publicKey)) return true;
    // A visitor's row stewards nothing, whatever switch it holds from before visitors were refused one.
    const row = db.prepare("SELECT can_operate, is_visitor FROM members WHERE public_key = ?").get(publicKey) as any;
    return !!row?.can_operate && !row.is_visitor;
}

/**
 * May this member drive THIS specific community enterprise? (#106)
 *
 * Authority requires BOTH the master switch (members.can_operate) and an explicit
 * treasury_operators binding, so an admin can suspend a steward node-wide without losing their
 * per-enterprise assignments. adminAssignTreasuryOperator sets the flag automatically, so a row can
 * never be silently inert.
 *
 * Gated for SPENDING operations: post offer, post need, approve a bid, complete and pay, sweep the balance,
 * and fund a federation commission.
 * NO admin bypass: requires a real treasury_operators row, exactly as for anyone else.
 *
 * An admin can rescue an abandoned enterprise by explicitly appointing themselves via
 * adminAssignTreasuryOperator, which creates a public, recorded, revocable binding.
 *
 * The actor's account must also be 'active'. A suspend_member Decision sets status = 'disabled' and
 * leaves can_operate and the binding alone, so without this a keeper the community suspended could
 * still list, edit and pay out as the enterprise. Checked here rather than in canOperate(), whose other
 * callers (getBalance, keeperOf) only drive what the client shows; admin moderation goes through
 * canAdministerTreasury, which returns before reaching this.
 */
export function canOperateTreasury(publicKey: string, treasuryPubkey: string): boolean {
    if (!canOperate(publicKey)) return false;
    // A visitor's row keeps no enterprise, whatever keeper row it holds from before visitors were refused one.
    const row = db.prepare(`
        SELECT 1 FROM treasury_operators o
        JOIN members m ON m.public_key = o.member_pubkey
        WHERE o.member_pubkey = ? AND o.treasury_pubkey = ? AND m.status = 'active' AND m.is_visitor = 0
    `).get(publicKey, treasuryPubkey);
    return !!row;
}

/**
 * May this actor perform REPAIR AND MODERATION actions on this enterprise?
 * Covers non-spending administrative actions: pausing an enterprise, unbinding a keeper,
 * archiving an abandoned enterprise, taking down a listing.
 *
 * The node admin IS allowed here (break-glass repair / moderation authority), as is any
 * legitimate keeper of the enterprise.
 */
export function canAdministerTreasury(publicKey: string, treasuryPubkey: string): boolean {
    if (publicKey === 'admin' || publicKey === 'owner:password' || isAdminPubkey(publicKey)) return true;
    return canOperateTreasury(publicKey, treasuryPubkey);
}

/**
 * Who hears of an application to keep an enterprise: the applicant, and the people GET .../keepers/requests
 * lets read it (the lead or sole keeper, and node admins). It names the applicant and what they pledge.
 */
function keeperRequestRecipients(enterprisePubkey: string, applicantPubkey: string): string[] {
    const candidates = new Set<string>([
        ...(db.prepare('SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = ?').all(enterprisePubkey) as any[]).map(r => r.member_pubkey),
        ...listNodeRoles().map(r => r.member_pubkey),
        ...(getAdminPubkey() ? [getAdminPubkey()] : []),
    ]);
    return [applicantPubkey, ...[...candidates].filter(pk => pk !== applicantPubkey && isLeadOrSoleKeeperOrAdmin(enterprisePubkey, pk))];
}

/**
 * Authority predicate for enterprise lead-level governance (docs/the-commons.md §2.2, §2.3).
 * Matches the authority predicate initiateWindUp and finaliseWindUp use:
 * the lead keeper, the sole keeper, or a node admin.
 *
 * The ACTOR must be active with the operator switch on. The sole-keeper COUNT is every binding, suspended
 * keepers included: a suspended keeper keeps their row (adminSetOperator, the suspend_member Decision), a
 * removed one does not. Counting only active keepers would let a community's suspension of the lead turn
 * the remaining keeper into a "sole keeper" who could approve keepers and wind the enterprise up alone
 * (PR #838 B1). A visitor's row is no actor here, whatever keeper row it holds from before visitors were refused one; it
 * still counts as a binding, as a suspended keeper does.
 */
export function isLeadOrSoleKeeperOrAdmin(enterprisePubkey: string, actorPubkey: string): boolean {
    if (isAdminPubkey(actorPubkey)) return true;
    const mem = db.prepare("SELECT status, can_operate, is_visitor FROM members WHERE public_key = ?").get(actorPubkey) as any;
    if (!mem || mem.is_visitor || mem.status !== 'active' || mem.can_operate !== 1) return false;
    const op = db.prepare("SELECT role FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(enterprisePubkey, actorPubkey) as any;
    if (!op) return false;
    const opCount = (db.prepare("SELECT COUNT(*) as c FROM treasury_operators WHERE treasury_pubkey = ?").get(enterprisePubkey) as any)?.c ?? 0;
    const isSoleKeeper = opCount === 1;
    const isLead = op.role === 'lead';
    return isLead || isSoleKeeper;
}

/**
 * Which enterprises does this member keep? Drives the Commons tab's per-enterprise controls —
 * the client needs the list, not a boolean, to know which cards get an operate panel.
 *
 * No admin bypass: an admin sees only the enterprises they have explicitly been appointed to keep.
 */
export function keeperOf(publicKey: string): string[] {
    if (!canOperate(publicKey)) return [];
    // Same account-status rule as canOperateTreasury: a keeper a Decision suspended keeps their binding but
    // cannot act, so the client must not be told they operate anything (#845 follow-up).
    return (db.prepare(`
        SELECT o.treasury_pubkey FROM treasury_operators o
        JOIN members m ON m.public_key = o.member_pubkey
        WHERE o.member_pubkey = ? AND m.status = 'active' AND m.is_visitor = 0
    `).all(publicKey) as any[]).map(r => r.treasury_pubkey);
}

/**
 * Who keeps this enterprise? Public — stewardship is transparent to members by design
 * (docs/community-governance.md), so a community can see who is accountable for what.
 * Suspended keepers (operator switch off, or account not active) are listed with `suspended: true` rather
 * than hidden: they still count toward "sole keeper" (isLeadOrSoleKeeperOrAdmin), so hiding them would
 * show one keeper while the server says there are two. They cannot act; nor can a visitor's row, listed the same way.
 */
export function treasuryKeepers(treasuryPubkey: string): Array<{
    publicKey: string;
    callsign: string;
    avatarUrl: string | null;
    grantedAt: string | null;
    role: string;
    backing: number;
    lastActiveAt: string | null;
    suspended: boolean;
}> {
    return (db.prepare(`
        SELECT m.public_key, m.callsign, m.avatar_url, o.granted_at, o.role, o.backing, m.last_active_at, m.joined_at,
               m.can_operate, m.status, m.is_visitor
        FROM treasury_operators o
        JOIN members m ON m.public_key = o.member_pubkey
        WHERE o.treasury_pubkey = ?
        ORDER BY o.granted_at
    `).all(treasuryPubkey) as any[]).map(r => ({
        publicKey: r.public_key,
        callsign: r.callsign,
        avatarUrl: avatarUrlFor(r.public_key, r.avatar_url),
        grantedAt: r.granted_at ?? null,
        role: r.role || 'keeper',
        backing: Number(r.backing || 0),
        lastActiveAt: lastActiveForViewer(r.last_active_at || r.joined_at, r.public_key),
        suspended: r.can_operate !== 1 || r.status !== 'active' || !!r.is_visitor,
    }));
}

/**
 * Bind a member to one enterprise. Also raises the can_operate master switch, so an assignment is
 * never silently inert. `grantedBy` records the granting admin's pubkey today, and is deliberately
 * untyped so an `appoint` Decision id can be recorded here later without a migration.
 */
export function clearEnterpriseFloorCache(enterprisePubkey?: string): void {
    engine.clearEnterpriseFloorCache(db, enterprisePubkey);
}

export function getEnterpriseFloor(enterprisePubkey: string): engine.EnterpriseFloorInfo {
    return engine.getEnterpriseFloor(db, enterprisePubkey);
}

export function adminAssignTreasuryOperator(treasuryPubkey: string, memberPubkey: string, grantedBy = 'admin', backing = 0): { ok: true } {
    // A visitor's row keeps nothing, as a key with no row keeps nothing (getActingMember).
    const member = getActingMember(memberPubkey);
    if (!member) throw new Error('Member not found');
    if (member.isTreasury) throw new Error('A treasury cannot keep another treasury');
    const t = db.prepare("SELECT is_treasury FROM members WHERE public_key = ?").get(treasuryPubkey) as any;
    if (!t?.is_treasury) throw new Error('Not a treasury');

    db.transaction(() => {
        db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by, backing)
                    VALUES (?, ?, 'keeper', ?, ?)
                    ON CONFLICT(treasury_pubkey, member_pubkey) DO UPDATE SET backing = excluded.backing`).run(treasuryPubkey, memberPubkey, grantedBy, backing);
        db.prepare("UPDATE members SET can_operate = 1 WHERE public_key = ?").run(memberPubkey);
    })();
    clearEnterpriseFloorCache(treasuryPubkey);
    broadcast({ type: 'profile_updated', publicKey: memberPubkey });
    return { ok: true };
}

/**
 * Unbind a member from one enterprise. Symmetric with assign (docs/community-governance.md asks for
 * appoint/remove to be one primitive, so removal needs no separate workflow).
 *
 * Clears can_operate once a member keeps nothing, so `canOperate()` keeps meaning "is a keeper"
 * and the fleet manager's display stays truthful.
 *
 * Handles keeper exit backing release/covenant lock (docs/the-commons.md §2.6).
 */
export function adminRevokeTreasuryOperator(treasuryPubkey: string, memberPubkey: string): { ok: true } {
    let promoted: string | null = null;
    db.transaction(() => {
        const wasLead = (db.prepare("SELECT role FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?")
            .get(treasuryPubkey, memberPubkey) as any)?.role === 'lead';
        unbindKeeper(treasuryPubkey, memberPubkey);
        if (wasLead) promoted = promoteOrPauseAfterLeadLeft(treasuryPubkey, 'admin').promoted;
    })();
    clearEnterpriseFloorCache(treasuryPubkey);
    broadcast({ type: 'profile_updated', publicKey: memberPubkey });
    if (promoted) broadcast({ type: 'profile_updated', publicKey: promoted });
    broadcast({ type: 'profile_updated', publicKey: treasuryPubkey });
    return { ok: true };
}

/**
 * The allowance the enterprise would still have from everyone else's pledges if this keeper's pledge went:
 * the other active, unfrozen keepers' pledges (or the legacy floor, whichever is larger), capped.
 */
function allowanceWithoutKeeper(treasuryPubkey: string, memberPubkey: string): number {
    const totalRow = db.prepare(`
        SELECT COALESCE(SUM(p.amount), 0) as total
        FROM enterprise_pledges p
        JOIN members m ON m.public_key = p.keeper
        WHERE p.enterprise = ?
          AND p.keeper != ?
          AND p.released_at IS NULL
          AND m.status = 'active'
          AND COALESCE(m.credit_frozen, 0) = 0
    `).get(treasuryPubkey, memberPubkey) as any;
    const otherPledges = Number(totalRow?.total || 0);
    const memberRow = db.prepare("SELECT legacy_credit_floor FROM members WHERE public_key = ?").get(treasuryPubkey) as any;
    const legacyFloor = Number(memberRow?.legacy_credit_floor || 0);
    return Math.min(PROTOCOL_CONSTANTS.CREDIT_FLOOR_CAP, Math.max(legacyFloor, otherPledges));
}

function activePledgeTotal(treasuryPubkey: string, memberPubkey: string): number {
    const row = db.prepare(
        "SELECT COALESCE(SUM(amount), 0) as total FROM enterprise_pledges WHERE keeper = ? AND enterprise = ? AND released_at IS NULL"
    ).get(memberPubkey, treasuryPubkey) as any;
    return Number(row?.total || 0);
}

/**
 * Remove one keeper binding and settle their pledge (docs/the-commons.md §2.6). Runs inside the caller's
 * transaction; the caller clears the floor cache and broadcasts.
 * Solvent (or the remaining keepers cover the deficit): the pledge is released in full.
 * Otherwise: the part of the pledge the deficit still needs stays locked, the rest is released (Rule 3).
 */
function unbindKeeper(treasuryPubkey: string, memberPubkey: string): void {
    db.prepare("DELETE FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?")
        .run(treasuryPubkey, memberPubkey);
    const left = db.prepare("SELECT COUNT(*) AS c FROM treasury_operators WHERE member_pubkey = ?")
        .get(memberPubkey) as any;
    if (!left?.c) db.prepare("UPDATE members SET can_operate = 0 WHERE public_key = ?").run(memberPubkey);

    const keeperPledge = activePledgeTotal(treasuryPubkey, memberPubkey);
    if (keeperPledge > 0) {
        const deficit = Math.max(0, -getBalance(treasuryPubkey).balance);
        const otherAllowance = allowanceWithoutKeeper(treasuryPubkey, memberPubkey);
        if (otherAllowance >= deficit) {
            db.prepare(
                "UPDATE enterprise_pledges SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE keeper = ? AND enterprise = ? AND released_at IS NULL"
            ).run(memberPubkey, treasuryPubkey);
        } else {
            const lockedNeeded = Math.min(keeperPledge, deficit - otherAllowance);
            const toRelease = keeperPledge - lockedNeeded;
            if (toRelease > 0) {
                const nowIso = new Date().toISOString();
                db.prepare(
                    "UPDATE enterprise_pledges SET released_at = ? WHERE keeper = ? AND enterprise = ? AND released_at IS NULL"
                ).run(nowIso, memberPubkey, treasuryPubkey);
                db.prepare(`
                    INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
                    VALUES (?, ?, ?, ?, ?, NULL)
                `).run(crypto.randomUUID(), memberPubkey, treasuryPubkey, lockedNeeded, nowIso);
            }
        }
    }

    // Nothing pending may still name someone who has left: a change about them, or one they made as lead.
    closePendingKeeperChangesFor(treasuryPubkey, memberPubkey, 'They are no longer a keeper of this enterprise');
}

/**
 * The lead has gone (removed by a community Decision, stepped down, or unbound by an admin) — answer G,
 * 2026-09-19. The longest-serving remaining ACTIVE keeper becomes lead at once, marked auto-promoted so the
 * other keepers may run succession immediately to choose someone else. No active keeper left: the enterprise
 * pauses (its next step is wind-up). Runs inside the caller's transaction; the caller broadcasts.
 */
export function promoteOrPauseAfterLeadLeft(enterprisePubkey: string, by: string): { promoted: string | null; paused: boolean } {
    if (db.prepare("SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND role = 'lead'").get(enterprisePubkey)) {
        return { promoted: null, paused: false };
    }
    const nowIso = new Date().toISOString();
    // A proposal to replace the departed lead is moot.
    db.prepare(`UPDATE enterprise_succession_proposals SET status = 'cancelled', closed_reason = 'lead_changed'
                WHERE enterprise_pubkey = ? AND status = 'active'`).run(enterprisePubkey);

    // Never a visitor's row: it acts for no enterprise (isActiveKeeperOf).
    const next = db.prepare(`
        SELECT o.member_pubkey FROM treasury_operators o
        JOIN members m ON m.public_key = o.member_pubkey
        WHERE o.treasury_pubkey = ? AND m.status = 'active' AND COALESCE(m.can_operate, 0) = 1 AND m.is_visitor = 0
        ORDER BY o.granted_at ASC, o.rowid ASC
        LIMIT 1
    `).get(enterprisePubkey) as any;
    if (next) {
        db.prepare("UPDATE treasury_operators SET role = 'lead', auto_promoted_at = ? WHERE treasury_pubkey = ? AND member_pubkey = ?")
            .run(nowIso, enterprisePubkey, next.member_pubkey);
        return { promoted: next.member_pubkey, paused: false };
    }

    const ent = db.prepare("SELECT paused, status FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!ent || ent.paused === 1 || ent.status === 'completed') return { promoted: null, paused: ent?.paused === 1 };
    const currentUsable = usableFloor(enterprisePubkey);
    const { floor: underlyingFloor } = getEnterpriseUnderlyingFloor(enterprisePubkey);
    const snapshot = currentUsable !== 0 ? currentUsable : underlyingFloor;
    db.prepare("UPDATE members SET paused = 1, paused_at = ?, paused_by = ?, paused_floor_snapshot = ? WHERE public_key = ?")
        .run(nowIso, by, snapshot, enterprisePubkey);
    return { promoted: null, paused: true };
}

/**
 * Available earned credit that a keeper can pledge to back enterprises (docs/the-commons.md §2.4 Rule 3).
 * A keeper's earned credit is never deducted from their personal floor, but is counted once across all
 * enterprises they keep.
 * Pledges are incremental: headroom is earned credit minus ALL active pledges across all enterprises.
 * Returns 0 if account is inactive (disabled/pruned) or credit-frozen.
 */
export function getAvailableBacking(keeperPubkey: string, _forEnterprise?: string): number {
    const km = db.prepare("SELECT status, credit_frozen FROM members WHERE public_key = ?").get(keeperPubkey) as any;
    if (!km || km.status === 'disabled' || km.status === 'pruned' || km.credit_frozen === 1) {
        return 0;
    }
    const { earnedCredit } = getMemberTrustProfile(keeperPubkey);
    const row = db.prepare(
        "SELECT COALESCE(SUM(amount), 0) as total FROM enterprise_pledges WHERE keeper = ? AND released_at IS NULL"
    ).get(keeperPubkey) as any;
    const totalPledged = Number(row?.total || 0);
    return Math.max(0, earnedCredit - totalPledged);
}

/**
 * List active pledges backing an enterprise.
 */
export function getEnterprisePledges(enterprisePubkey: string): Array<{
    id: string;
    keeper: string;
    callsign: string;
    avatarUrl: string | null;
    amount: number;
    pledgedAt: string;
}> {
    return (db.prepare(`
        SELECT p.id, p.keeper, p.amount, p.pledged_at, m.callsign, m.avatar_url
        FROM enterprise_pledges p
        JOIN members m ON m.public_key = p.keeper
        WHERE p.enterprise = ? AND p.released_at IS NULL
        ORDER BY p.pledged_at ASC
    `).all(enterprisePubkey) as any[]).map(r => ({
        id: r.id,
        keeper: r.keeper,
        callsign: r.callsign,
        avatarUrl: avatarUrlFor(r.keeper, r.avatar_url),
        amount: Number(r.amount),
        pledgedAt: r.pledged_at,
    }));
}

/**
 * List active pledges made by a keeper.
 */
export function getKeeperPledges(keeperPubkey: string): Array<{
    id: string;
    enterprise: string;
    callsign: string;
    avatarUrl: string | null;
    amount: number;
    pledgedAt: string;
}> {
    return (db.prepare(`
        SELECT p.id, p.enterprise, p.amount, p.pledged_at, m.callsign, m.avatar_url
        FROM enterprise_pledges p
        JOIN members m ON m.public_key = p.enterprise
        WHERE p.keeper = ? AND p.released_at IS NULL
        ORDER BY p.pledged_at ASC
    `).all(keeperPubkey) as any[]).map(r => ({
        id: r.id,
        enterprise: r.enterprise,
        callsign: r.callsign,
        avatarUrl: avatarUrlFor(r.enterprise, r.avatar_url),
        amount: Number(r.amount),
        pledgedAt: r.pledged_at,
    }));
}

/**
 * Explicit, once-only backing pledge of a keeper's earned credit to back an enterprise (docs/the-commons.md §2.4 Rules 1-4).
 * Gated by keepership (must have a treasury_operators row and can_operate = 1).
 */
export function pledgeEnterpriseBacking(
    enterprisePubkey: string,
    keeperPubkey: string,
    amount: number
): { id: string; enterprise: string; keeper: string; amount: number; pledgedAt: string } {
    const res = db.transaction(() => {
        const t = db.prepare("SELECT is_treasury, status FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
        if (!t?.is_treasury) throw new Error('Not an enterprise');
        if (t.status === 'disabled' || t.status === 'pruned') {
            throw new Error('This enterprise has been closed, so no backing can be pledged to it.');
        }

        const km = db.prepare("SELECT status, can_operate, credit_frozen FROM members WHERE public_key = ?").get(keeperPubkey) as any;
        if (!km || km.status === 'disabled' || km.status === 'pruned') {
            throw new Error('Your account is not active, so you cannot back this enterprise.');
        }
        if (km.credit_frozen === 1) {
            throw new Error('Your credit is frozen, so you cannot back this enterprise.');
        }

        if (!canOperateTreasury(keeperPubkey, enterprisePubkey)) {
            throw new Error('You are not an authorized keeper of this enterprise');
        }

        const parsedAmount = Number(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            throw new Error('Pledge amount must be a positive number');
        }

        const totalPledgedRow = db.prepare(
            "SELECT COALESCE(SUM(amount), 0) as total FROM enterprise_pledges WHERE keeper = ? AND released_at IS NULL"
        ).get(keeperPubkey) as any;
        const totalPledgedAll = Number(totalPledgedRow?.total || 0);
        const { earnedCredit } = getMemberTrustProfile(keeperPubkey);
        const availableToAdd = Math.max(0, earnedCredit - totalPledgedAll);

        if (parsedAmount > availableToAdd) {
            throw new Error(`Pledge amount (${parsedAmount}) exceeds available earned credit (${availableToAdd} available to add across all enterprises)`);
        }

        const pledgeToAdd = parsedAmount;
        const pledgeId = crypto.randomUUID();
        const pledgedAt = new Date().toISOString();

        db.prepare(`
            INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
            VALUES (?, ?, ?, ?, ?, NULL)
        `).run(pledgeId, keeperPubkey, enterprisePubkey, pledgeToAdd, pledgedAt);

        // Auto-clear legacy credit floor once keepers' derived pledges reach or exceed it (Slice 4)
        const legacyRow = db.prepare("SELECT legacy_credit_floor FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
        const legacyFloor = Number(legacyRow?.legacy_credit_floor || 0);
        if (legacyFloor > 0) {
            const pledgeSumRow = db.prepare(`
                SELECT COALESCE(SUM(p.amount), 0) as total
                FROM enterprise_pledges p
                JOIN members m ON m.public_key = p.keeper
                WHERE p.enterprise = ?
                  AND p.released_at IS NULL
                  AND m.status = 'active'
                  AND COALESCE(m.credit_frozen, 0) = 0
            `).get(enterprisePubkey) as any;
            const totalActiveDerived = Number(pledgeSumRow?.total || 0);
            if (totalActiveDerived >= legacyFloor) {
                db.prepare("UPDATE members SET legacy_credit_floor = NULL WHERE public_key = ?").run(enterprisePubkey);
                broadcast({ type: 'profile_updated', publicKey: enterprisePubkey });
            }
        }

        return { id: pledgeId, enterprise: enterprisePubkey, keeper: keeperPubkey, amount: pledgeToAdd, pledgedAt };
    })();

    clearEnterpriseFloorCache(enterprisePubkey);
    broadcast({ type: 'enterprise_pledge_updated', enterprise: enterprisePubkey, keeper: keeperPubkey });
    return res;
}

/**
 * Release backing pledge from an enterprise (docs/the-commons.md §2.4 Rule 3).
 * Covenant: a keeper can release only what leaves the enterprise above its current deficit.
 */
export function releaseEnterpriseBacking(
    enterprisePubkey: string,
    keeperPubkey: string,
    amountToRelease?: number
): { releasedAmount: number; remainingPledge: number } {
    const res = db.transaction(() => {
        const t = db.prepare("SELECT is_treasury, legacy_credit_floor FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
        if (!t?.is_treasury) throw new Error('Not an enterprise');

        const activeRow = db.prepare(
            "SELECT COALESCE(SUM(amount), 0) as total FROM enterprise_pledges WHERE keeper = ? AND enterprise = ? AND released_at IS NULL"
        ).get(keeperPubkey, enterprisePubkey) as any;
        const currentKeeperPledge = Number(activeRow?.total || 0);

        const bound = db.prepare("SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(enterprisePubkey, keeperPubkey);
        const hasActivePledge = currentKeeperPledge > 0;
        // A visitor's row is neither, whatever it holds from before visitors were refused a keeper's row.
        if (((!bound && !hasActivePledge) || isVisitorKey(keeperPubkey)) && !isAdminPubkey(keeperPubkey)) {
            throw new Error('You are not an authorized keeper or pledge holder of this enterprise');
        }

        if (currentKeeperPledge <= 0) {
            throw new Error('No active backing pledge found for this enterprise');
        }

        let toRelease = (amountToRelease !== undefined && amountToRelease !== null) ? Number(amountToRelease) : currentKeeperPledge;
        if (!Number.isFinite(toRelease) || toRelease <= 0) {
            throw new Error('Release amount must be a positive number');
        }
        toRelease = Math.min(toRelease, currentKeeperPledge);

        // Covenant check: enterprise balance deficit
        const balance = getBalance(enterprisePubkey).balance;
        const deficit = Math.max(0, -balance);

        const totalPledgesRow = db.prepare(`
            SELECT COALESCE(SUM(p.amount), 0) as total
            FROM enterprise_pledges p
            JOIN members m ON m.public_key = p.keeper
            WHERE p.enterprise = ?
              AND p.released_at IS NULL
              AND m.status = 'active'
              AND COALESCE(m.credit_frozen, 0) = 0
        `).get(enterprisePubkey) as any;
        const currentTotalPledges = Number(totalPledgesRow?.total || 0);
        const newTotalPledges = currentTotalPledges - toRelease;
        const legacyFloor = Number(t.legacy_credit_floor || 0);

        const newAllowance = Math.min(PROTOCOL_CONSTANTS.CREDIT_FLOOR_CAP, Math.max(legacyFloor, newTotalPledges));
        if (newAllowance < deficit) {
            throw new Error(`Cannot release backing: enterprise is in deficit (${deficit} beans) and remaining allowance (${newAllowance} beans) would not cover it`);
        }

        const remainingPledge = currentKeeperPledge - toRelease;
        const nowIso = new Date().toISOString();

        db.prepare(
            "UPDATE enterprise_pledges SET released_at = ? WHERE keeper = ? AND enterprise = ? AND released_at IS NULL"
        ).run(nowIso, keeperPubkey, enterprisePubkey);

        if (remainingPledge > 0) {
            const newPledgeId = crypto.randomUUID();
            db.prepare(`
                INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
                VALUES (?, ?, ?, ?, ?, NULL)
            `).run(newPledgeId, keeperPubkey, enterprisePubkey, remainingPledge, nowIso);
        }

        return { releasedAmount: toRelease, remainingPledge };
    })();

    clearEnterpriseFloorCache(enterprisePubkey);
    broadcast({ type: 'enterprise_pledge_updated', enterprise: enterprisePubkey, keeper: keeperPubkey });
    return res;
}

// -------------------------------------------------------------------------------------
// Enterprise Keepers: Join Requests & Lead Succession (docs/the-commons.md §2.3, §2.4 Rule 3, §2.6)
// -------------------------------------------------------------------------------------

export interface KeeperJoinRequest {
    id: string;
    enterprisePubkey: string;
    memberPubkey: string;
    callsign?: string;
    avatarUrl?: string | null;
    pledgedBacking: number;
    status: 'pending' | 'approved' | 'declined' | 'cancelled';
    createdAt: string;
    decidedAt?: string | null;
    decidedBy?: string | null;
    availableToBack?: number;
    earnedCredit?: number;
    /** Approved by the lead and waiting out the other keepers' 3-day objection window (answer A). */
    pendingChange?: KeeperChangeInfo | null;
}

/**
 * A member asks to join an enterprise as a keeper, with an explicit backing pledge (0 .. available).
 * (docs/the-commons.md §2.3, §2.4 Rule 3).
 * A pledge of 0 is valid. Re-validated at request time AND at approval time.
 */
export function requestToJoinEnterprise(
    enterprisePubkey: string,
    memberPubkey: string,
    pledgedBacking: number
): KeeperJoinRequest {
    const ent = db.prepare("SELECT is_treasury, status FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!ent || !ent.is_treasury) {
        throw new Error('Not an enterprise');
    }
    if (ent.status === 'completed') {
        throw new Error('Completed enterprise accepts no requests');
    }
    if (ent.status === 'disabled' || ent.status === 'pruned') {
        throw new Error('This enterprise has been closed');
    }

    // A visitor's row is refused as a key with no row is.
    const km = db.prepare("SELECT status, credit_frozen, is_visitor FROM members WHERE public_key = ?").get(memberPubkey) as any;
    if (!km || km.is_visitor || km.status !== 'active') {
        throw new Error('Your account is not active, so you cannot join as a keeper');
    }
    if (km.credit_frozen === 1) {
        throw new Error('Your credit is frozen, so you cannot join as a keeper');
    }
    if (isOperatorSwitchedOff(memberPubkey)) {
        throw new Error('Your operator access is switched off by a node admin, so you cannot join as a keeper');
    }

    const existingOp = db.prepare(
        "SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?"
    ).get(enterprisePubkey, memberPubkey);
    if (existingOp) {
        throw new Error('Already a keeper of this enterprise');
    }

    const pending = db.prepare(
        "SELECT 1 FROM enterprise_keeper_requests WHERE enterprise_pubkey = ? AND member_pubkey = ? AND status = 'pending'"
    ).get(enterprisePubkey, memberPubkey);
    if (pending) {
        throw new Error('A pending request already exists for this enterprise');
    }

    const parsedAmount = Number(pledgedBacking);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
        throw new Error('Pledge amount must be non-negative');
    }

    const available = getAvailableBacking(memberPubkey);
    if (parsedAmount > available) {
        throw new Error(`Pledge amount (${parsedAmount}) exceeds available earned credit (${available} available to back across all enterprises)`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO enterprise_keeper_requests (id, enterprise_pubkey, member_pubkey, pledged_backing, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(id, enterprisePubkey, memberPubkey, parsedAmount, now);

    broadcast({ type: 'enterprise_keeper_request_created', enterprisePubkey, memberPubkey, requestId: id, pledgedBacking: parsedAmount }, keeperRequestRecipients(enterprisePubkey, memberPubkey));

    return {
        id,
        enterprisePubkey,
        memberPubkey,
        pledgedBacking: parsedAmount,
        status: 'pending',
        createdAt: now,
    };
}

/**
 * List keeper requests for an enterprise, visible to keepers / applicants.
 */
export function getKeeperRequests(enterprisePubkey: string, filterStatus?: string): KeeperJoinRequest[] {
    let sql = `
        SELECT r.id, r.enterprise_pubkey, r.member_pubkey, r.pledged_backing, r.status,
               r.created_at, r.decided_at, r.decided_by, m.callsign, m.avatar_url
        FROM enterprise_keeper_requests r
        JOIN members m ON m.public_key = r.member_pubkey
        WHERE r.enterprise_pubkey = ?
    `;
    const params: any[] = [enterprisePubkey];
    if (filterStatus) {
        sql += ` AND r.status = ?`;
        params.push(filterStatus);
    }
    sql += ` ORDER BY r.created_at DESC`;

    const pendingByRequest = new Map<string, KeeperChangeInfo>();
    for (const c of getKeeperChanges(enterprisePubkey, 'pending')) {
        if (c.requestId) pendingByRequest.set(c.requestId, c);
    }

    return (db.prepare(sql).all(...params) as any[]).map(r => {
        const trust = getMemberTrustProfile(r.member_pubkey);
        const available = getAvailableBacking(r.member_pubkey);
        return {
            id: r.id,
            enterprisePubkey: r.enterprise_pubkey,
            memberPubkey: r.member_pubkey,
            callsign: r.callsign,
            avatarUrl: avatarUrlFor(r.member_pubkey, r.avatar_url),
            pledgedBacking: Number(r.pledged_backing),
            status: r.status,
            createdAt: r.created_at,
            decidedAt: r.decided_at,
            decidedBy: r.decided_by,
            availableToBack: available,
            earnedCredit: trust.earnedCredit,
            pendingChange: pendingByRequest.get(r.id) ?? null,
        };
    });
}

/** How long the other keepers have to object to a keeper change the lead has made (answers A and M). */
export const KEEPER_CHANGE_OBJECTION_MS = 3 * 24 * 60 * 60 * 1000;
/** How long a succession proposal stays open (answer M). */
export const SUCCESSION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Never a visitor's row, whatever keeper row it holds from before visitors were refused one. */
function isActiveKeeperOf(enterprisePubkey: string, memberPubkey: string): boolean {
    return !!db.prepare(`
        SELECT 1 FROM treasury_operators o
        JOIN members m ON m.public_key = o.member_pubkey
        WHERE o.treasury_pubkey = ? AND o.member_pubkey = ? AND COALESCE(m.can_operate, 0) = 1 AND m.status = 'active' AND m.is_visitor = 0
    `).get(enterprisePubkey, memberPubkey);
}

function keeperBindingCount(enterprisePubkey: string): number {
    return Number((db.prepare("SELECT COUNT(*) as c FROM treasury_operators WHERE treasury_pubkey = ?").get(enterprisePubkey) as any)?.c ?? 0);
}

/**
 * A keeper change that can no longer be made for a business reason (the pledge is no longer available, the applicant
 * or keeper is no longer eligible, the lead has changed). The scheduler closes such a change as 'failed'; any other
 * error (a busy or broken database) leaves the change pending so the next tick retries it.
 */
export class KeeperChangeRefused extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KeeperChangeRefused';
    }
}

/**
 * Validate that an approved applicant may still become a keeper, then bind them with their pledge. Runs inside the
 * caller's transaction. Used by an immediate approval and by the scheduler when an objection window closes, so the
 * pledge is re-checked against the applicant's available backing at the moment the binding is made.
 */
function assertApplicantStillEligible(enterprisePubkey: string, memberPubkey: string, pledged: number): void {
    const ent = db.prepare("SELECT is_treasury, status FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!ent || !ent.is_treasury) throw new KeeperChangeRefused('Not an enterprise');
    if (ent.status === 'completed') throw new KeeperChangeRefused('Completed enterprise accepts no requests');
    if (ent.status === 'disabled' || ent.status === 'pruned') throw new KeeperChangeRefused('This enterprise has been closed');

    // A visitor's row, as when it asks (requestToJoinEnterprise): a request it made before visitors were refused one lands on nobody.
    const km = db.prepare("SELECT status, credit_frozen, is_visitor FROM members WHERE public_key = ?").get(memberPubkey) as any;
    if (!km || km.is_visitor || km.status !== 'active') {
        throw new KeeperChangeRefused('Applicant account is not active, so they cannot be approved as a keeper');
    }
    if (km.credit_frozen === 1) {
        throw new KeeperChangeRefused('Applicant credit is frozen, so they cannot be approved as a keeper');
    }
    // A lead's approval must never reverse an admin suspension (PR #838 B3).
    if (isOperatorSwitchedOff(memberPubkey)) {
        throw new KeeperChangeRefused("Applicant's operator access is switched off by a node admin, so they cannot be approved as a keeper");
    }
    if (db.prepare("SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(enterprisePubkey, memberPubkey)) {
        throw new KeeperChangeRefused('Already a keeper of this enterprise');
    }
    const available = getAvailableBacking(memberPubkey);
    if (pledged > available) {
        throw new KeeperChangeRefused(`Pledge amount (${pledged}) exceeds available earned credit at approval (${available} available)`);
    }
}

function bindApprovedKeeper(enterprisePubkey: string, memberPubkey: string, pledged: number, grantedBy: string): void {
    // The operator switch is raised only for a first binding. For anyone who already keeps an
    // enterprise the switch belongs to the admin, and a lead keeper's approval must not change it.
    const hadBinding = !!db.prepare("SELECT 1 FROM treasury_operators WHERE member_pubkey = ?").get(memberPubkey);
    db.prepare(`
        INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by, backing)
        VALUES (?, ?, 'keeper', ?, ?)
    `).run(enterprisePubkey, memberPubkey, grantedBy, pledged);
    if (!hadBinding) {
        db.prepare("UPDATE members SET can_operate = 1 WHERE public_key = ?").run(memberPubkey);
    }

    if (pledged > 0) {
        db.prepare(`
            INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
            VALUES (?, ?, ?, ?, ?, NULL)
        `).run(crypto.randomUUID(), memberPubkey, enterprisePubkey, pledged, new Date().toISOString());

        // Auto-clear legacy credit floor once keepers' derived pledges reach or exceed it (Slice 4)
        const legacyRow = db.prepare("SELECT legacy_credit_floor FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
        const legacyFloor = Number(legacyRow?.legacy_credit_floor || 0);
        if (legacyFloor > 0) {
            const pledgeSumRow = db.prepare(`
                SELECT COALESCE(SUM(p.amount), 0) as total
                FROM enterprise_pledges p
                JOIN members m ON m.public_key = p.keeper
                WHERE p.enterprise = ?
                  AND p.released_at IS NULL
                  AND m.status = 'active'
                  AND COALESCE(m.credit_frozen, 0) = 0
            `).get(enterprisePubkey) as any;
            if (Number(pledgeSumRow?.total || 0) >= legacyFloor) {
                db.prepare("UPDATE members SET legacy_credit_floor = NULL WHERE public_key = ?").run(enterprisePubkey);
            }
        }
    }
}

function broadcastKeeperBound(enterprisePubkey: string, memberPubkey: string): void {
    clearEnterpriseFloorCache(enterprisePubkey);
    broadcast({ type: 'profile_updated', publicKey: memberPubkey });
    broadcast({ type: 'profile_updated', publicKey: enterprisePubkey });
    broadcast({ type: 'enterprise_pledge_updated', enterprise: enterprisePubkey, keeper: memberPubkey });
    broadcast({ type: 'enterprise_keeper_approved', enterprisePubkey, memberPubkey });
}

/**
 * Approve a keeper join request (answer A, 2026-09-19).
 * Gated by lead keeper, sole keeper, or node admin (isLeadOrSoleKeeperOrAdmin).
 *
 * A one-keeper enterprise (and a node admin acting from outside it, break-glass) binds the applicant at once.
 * Otherwise the approval opens a 3-day window in which any other active keeper may object, which cancels it;
 * the scheduler binds the applicant when the window ends, re-checking their pledge then.
 */
export function approveKeeperRequest(requestId: string, actorPubkey: string): {
    ok: true; keeper: string; backing: number; applied: boolean; change: KeeperChangeInfo | null;
} {
    const req = db.prepare("SELECT * FROM enterprise_keeper_requests WHERE id = ?").get(requestId) as any;
    if (!req) throw new Error('Keeper request not found');
    if (req.status !== 'pending') throw new Error('Request is no longer pending');

    if (!isLeadOrSoleKeeperOrAdmin(req.enterprise_pubkey, actorPubkey)) {
        throw new Error('Only the lead keeper, sole keeper, or admin may approve keeper requests');
    }
    if (db.prepare("SELECT 1 FROM enterprise_keeper_changes WHERE request_id = ? AND status = 'pending'").get(requestId)) {
        throw new Error('This request is already approved and waiting out its objection window');
    }

    const pledged = Number(req.pledged_backing || 0);
    assertApplicantStillEligible(req.enterprise_pubkey, req.member_pubkey, pledged);

    const actorIsKeeper = !!db.prepare("SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?")
        .get(req.enterprise_pubkey, actorPubkey);
    const immediate = keeperBindingCount(req.enterprise_pubkey) <= 1 || (!actorIsKeeper && isAdminPubkey(actorPubkey));

    const now = new Date().toISOString();
    if (immediate) {
        db.transaction(() => {
            const updateRes = db.prepare(`
                UPDATE enterprise_keeper_requests
                SET status = 'approved', decided_at = ?, decided_by = ?
                WHERE id = ? AND status = 'pending'
            `).run(now, actorPubkey, requestId);
            if (updateRes.changes === 0) throw new Error('Request is no longer pending');
            bindApprovedKeeper(req.enterprise_pubkey, req.member_pubkey, pledged, actorPubkey);
        })();
        broadcastKeeperBound(req.enterprise_pubkey, req.member_pubkey);
        return { ok: true, keeper: req.member_pubkey, backing: pledged, applied: true, change: null };
    }

    const changeId = crypto.randomUUID();
    const appliesAt = new Date(Date.now() + KEEPER_CHANGE_OBJECTION_MS).toISOString();
    db.prepare(`
        INSERT INTO enterprise_keeper_changes (id, enterprise_pubkey, kind, member_pubkey, request_id, pledged_backing, proposed_by, status, created_at, applies_at)
        VALUES (?, ?, 'add', ?, ?, ?, ?, 'pending', ?, ?)
    `).run(changeId, req.enterprise_pubkey, req.member_pubkey, requestId, pledged, actorPubkey, now, appliesAt);
    broadcast({ type: 'enterprise_keeper_change_proposed', enterprisePubkey: req.enterprise_pubkey, changeId, kind: 'add', memberPubkey: req.member_pubkey, appliesAt });
    return { ok: true, keeper: req.member_pubkey, backing: pledged, applied: false, change: getKeeperChange(changeId) };
}

/**
 * Decline a keeper join request.
 * Gated by lead keeper, sole keeper, or node admin (isLeadOrSoleKeeperOrAdmin).
 * Leaves no keeper row and no backing. A request already approved and in its objection window is out of the
 * lead's hands: the other keepers object to it, or it lands.
 */
export function declineKeeperRequest(requestId: string, actorPubkey: string): { ok: true } {
    const req = db.prepare("SELECT * FROM enterprise_keeper_requests WHERE id = ?").get(requestId) as any;
    if (!req) throw new Error('Keeper request not found');
    if (req.status !== 'pending') throw new Error('Request is no longer pending');

    if (!isLeadOrSoleKeeperOrAdmin(req.enterprise_pubkey, actorPubkey)) {
        throw new Error('Only the lead keeper, sole keeper, or admin may decline keeper requests');
    }
    if (db.prepare("SELECT 1 FROM enterprise_keeper_changes WHERE request_id = ? AND status = 'pending'").get(requestId)) {
        throw new Error('This request is already approved and waiting out its objection window');
    }

    const now = new Date().toISOString();
    db.prepare(`
        UPDATE enterprise_keeper_requests
        SET status = 'declined', decided_at = ?, decided_by = ?
        WHERE id = ?
    `).run(now, actorPubkey, requestId);

    broadcast({ type: 'enterprise_keeper_declined', enterprisePubkey: req.enterprise_pubkey, memberPubkey: req.member_pubkey }, keeperRequestRecipients(req.enterprise_pubkey, req.member_pubkey));
    return { ok: true };
}

// -------------------------------------------------------------------------------------
// Keeper changes with an objection window (answers A and M, 2026-09-19)
// An enterprise's own membership is the keepers' own work: the lead acts, the other keepers can object.
// -------------------------------------------------------------------------------------

export interface KeeperChangeInfo {
    id: string;
    enterprisePubkey: string;
    kind: 'add' | 'remove';
    memberPubkey: string;
    memberCallsign: string;
    requestId: string | null;
    pledgedBacking: number;
    proposedBy: string;
    proposedByCallsign: string | null;
    status: 'pending' | 'applied' | 'objected' | 'failed';
    createdAt: string;
    appliesAt: string;
    resolvedAt: string | null;
    resolvedBy: string | null;
    resolvedByCallsign: string | null;
    reason: string | null;
}

function toKeeperChangeInfo(r: any): KeeperChangeInfo {
    return {
        id: r.id,
        enterprisePubkey: r.enterprise_pubkey,
        kind: r.kind,
        memberPubkey: r.member_pubkey,
        memberCallsign: r.member_callsign || r.member_pubkey.slice(0, 8),
        requestId: r.request_id ?? null,
        pledgedBacking: Number(r.pledged_backing || 0),
        proposedBy: r.proposed_by,
        proposedByCallsign: r.proposer_callsign ?? null,
        status: r.status,
        createdAt: r.created_at,
        appliesAt: r.applies_at,
        resolvedAt: r.resolved_at ?? null,
        resolvedBy: r.resolved_by ?? null,
        resolvedByCallsign: r.resolver_callsign ?? null,
        reason: r.reason ?? null,
    };
}

const KEEPER_CHANGE_SELECT = `
    SELECT c.*, mm.callsign AS member_callsign, pm.callsign AS proposer_callsign, rm.callsign AS resolver_callsign
    FROM enterprise_keeper_changes c
    LEFT JOIN members mm ON mm.public_key = c.member_pubkey
    LEFT JOIN members pm ON pm.public_key = c.proposed_by
    LEFT JOIN members rm ON rm.public_key = c.resolved_by
`;

export function getKeeperChange(changeId: string): KeeperChangeInfo | null {
    const r = db.prepare(`${KEEPER_CHANGE_SELECT} WHERE c.id = ?`).get(changeId);
    return r ? toKeeperChangeInfo(r) : null;
}

/** Keeper changes for an enterprise, newest first. Public, like the keeper list itself. */
export function getKeeperChanges(enterprisePubkey: string, status?: KeeperChangeInfo['status']): KeeperChangeInfo[] {
    applyDueKeeperChanges(enterprisePubkey);
    const rows = status
        ? db.prepare(`${KEEPER_CHANGE_SELECT} WHERE c.enterprise_pubkey = ? AND c.status = ? ORDER BY c.created_at DESC`).all(enterprisePubkey, status)
        : db.prepare(`${KEEPER_CHANGE_SELECT} WHERE c.enterprise_pubkey = ? ORDER BY c.created_at DESC`).all(enterprisePubkey);
    return (rows as any[]).map(toKeeperChangeInfo);
}

/**
 * Close every pending change that names this member — as the keeper being added or removed, or as the lead who
 * made it. Runs inside the caller's transaction.
 */
export function closePendingKeeperChangesFor(enterprisePubkey: string, memberPubkey: string, reason: string): void {
    const now = new Date().toISOString();
    const rows = db.prepare(`
        SELECT id, request_id FROM enterprise_keeper_changes
        WHERE enterprise_pubkey = ? AND status = 'pending' AND (member_pubkey = ? OR proposed_by = ?)
    `).all(enterprisePubkey, memberPubkey, memberPubkey) as any[];
    for (const r of rows) {
        db.prepare("UPDATE enterprise_keeper_changes SET status = 'failed', resolved_at = ?, reason = ? WHERE id = ?")
            .run(now, reason, r.id);
        if (r.request_id) {
            db.prepare("UPDATE enterprise_keeper_requests SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'")
                .run(now, r.request_id);
        }
    }
}

/**
 * The lead asks to remove an ordinary keeper (answer M, 2026-09-19). Same shape as adding one: any other active
 * keeper (not the keeper being removed) may object within 3 days, which cancels it; otherwise it is applied when
 * the window ends. A node admin acting from outside the enterprise removes at once (break-glass, as the admin
 * route already does). To leave yourself, step down instead.
 */
export function proposeKeeperRemoval(enterprisePubkey: string, actorPubkey: string, memberPubkey: string): {
    ok: true; applied: boolean; change: KeeperChangeInfo | null;
} {
    const ent = db.prepare("SELECT is_treasury, status FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!ent || !ent.is_treasury) throw new Error('Not an enterprise');
    if (ent.status === 'completed') throw new Error('Enterprise has already wound up');
    if (!isLeadOrSoleKeeperOrAdmin(enterprisePubkey, actorPubkey)) {
        throw new Error('Only the lead keeper may remove a keeper');
    }
    if (actorPubkey === memberPubkey) throw new Error('To leave this enterprise yourself, step down instead');

    const target = db.prepare("SELECT role FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?")
        .get(enterprisePubkey, memberPubkey) as any;
    if (!target) throw new Error('That member is not a keeper of this enterprise');
    if (target.role === 'lead') {
        throw new Error('The lead keeper cannot be removed this way — the lead can step down, or the community can decide');
    }
    applyDueKeeperChanges(enterprisePubkey);
    if (db.prepare("SELECT 1 FROM enterprise_keeper_changes WHERE enterprise_pubkey = ? AND member_pubkey = ? AND status = 'pending'")
        .get(enterprisePubkey, memberPubkey)) {
        throw new Error('A change for this keeper is already waiting out its objection window');
    }

    const actorIsKeeper = !!db.prepare("SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?")
        .get(enterprisePubkey, actorPubkey);
    if (!actorIsKeeper && isAdminPubkey(actorPubkey)) {
        adminRevokeTreasuryOperator(enterprisePubkey, memberPubkey);
        return { ok: true, applied: true, change: null };
    }

    const changeId = crypto.randomUUID();
    const now = new Date().toISOString();
    const appliesAt = new Date(Date.now() + KEEPER_CHANGE_OBJECTION_MS).toISOString();
    db.prepare(`
        INSERT INTO enterprise_keeper_changes (id, enterprise_pubkey, kind, member_pubkey, pledged_backing, proposed_by, status, created_at, applies_at)
        VALUES (?, ?, 'remove', ?, 0, ?, 'pending', ?, ?)
    `).run(changeId, enterprisePubkey, memberPubkey, actorPubkey, now, appliesAt);
    broadcast({ type: 'enterprise_keeper_change_proposed', enterprisePubkey, changeId, kind: 'remove', memberPubkey, appliesAt });
    return { ok: true, applied: false, change: getKeeperChange(changeId) };
}

/**
 * Object to a pending keeper change. Any active keeper of the enterprise other than the lead who made it — and,
 * for a removal, other than the keeper being removed — may object while the window is open. One objection cancels.
 */
export function objectToKeeperChange(changeId: string, actorPubkey: string): { ok: true; change: KeeperChangeInfo } {
    const c = db.prepare("SELECT * FROM enterprise_keeper_changes WHERE id = ?").get(changeId) as any;
    if (!c) throw new Error('Keeper change not found');
    applyDueKeeperChanges(c.enterprise_pubkey);
    const cur = db.prepare("SELECT * FROM enterprise_keeper_changes WHERE id = ?").get(changeId) as any;
    if (cur.status !== 'pending') throw new Error('The objection window for this change has closed');

    if (!isActiveKeeperOf(c.enterprise_pubkey, actorPubkey)) {
        throw new Error('Only an active keeper of this enterprise may object');
    }
    if (actorPubkey === c.proposed_by) throw new Error('You made this change — you cannot object to it');
    if (actorPubkey === c.member_pubkey) throw new Error('You cannot object to your own removal');

    const now = new Date().toISOString();
    db.transaction(() => {
        const res = db.prepare(`
            UPDATE enterprise_keeper_changes SET status = 'objected', resolved_at = ?, resolved_by = ?, reason = 'A keeper objected'
            WHERE id = ? AND status = 'pending'
        `).run(now, actorPubkey, changeId);
        if (res.changes === 0) throw new Error('The objection window for this change has closed');
        if (c.request_id) {
            db.prepare(`UPDATE enterprise_keeper_requests SET status = 'declined', decided_at = ?, decided_by = ?
                        WHERE id = ? AND status = 'pending'`).run(now, actorPubkey, c.request_id);
        }
    })();
    broadcast({ type: 'enterprise_keeper_change_objected', enterprisePubkey: c.enterprise_pubkey, changeId, kind: c.kind, memberPubkey: c.member_pubkey });
    return { ok: true, change: getKeeperChange(changeId)! };
}

/**
 * Apply one pending change whose window has ended. Everything is re-checked now: the lead who made it must still
 * be the lead, an applicant must still be eligible with their pledge still available, a keeper being removed must
 * still be an ordinary keeper. Anything that no longer holds (a KeeperChangeRefused) closes the change as 'failed'
 * with the reason. Any other error is logged and the change stays pending for the next tick.
 */
function applyKeeperChange(c: any, nowIso: string): 'applied' | 'failed' | 'retry' {
    let outcome: 'applied' | 'failed' = 'applied';
    let failReason: string | null = null;
    try {
        db.transaction(() => {
            if (!isLeadOrSoleKeeperOrAdmin(c.enterprise_pubkey, c.proposed_by)) throw new KeeperChangeRefused('The keeper who made this change is no longer the lead');

            if (c.kind === 'add') {
                assertApplicantStillEligible(c.enterprise_pubkey, c.member_pubkey, Number(c.pledged_backing || 0));
                if (c.request_id) {
                    db.prepare(`UPDATE enterprise_keeper_requests SET status = 'approved', decided_at = ?, decided_by = ?
                                WHERE id = ? AND status = 'pending'`).run(nowIso, c.proposed_by, c.request_id);
                }
                bindApprovedKeeper(c.enterprise_pubkey, c.member_pubkey, Number(c.pledged_backing || 0), c.proposed_by);
            } else {
                const target = db.prepare("SELECT role FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?")
                    .get(c.enterprise_pubkey, c.member_pubkey) as any;
                if (!target) throw new KeeperChangeRefused('They are no longer a keeper of this enterprise');
                if (target.role === 'lead') throw new KeeperChangeRefused('They have since become the lead keeper');
                // Mark this change applied first: unbindKeeper closes whatever else is still pending for this member.
                db.prepare("UPDATE enterprise_keeper_changes SET status = 'applied', resolved_at = ? WHERE id = ?").run(nowIso, c.id);
                unbindKeeper(c.enterprise_pubkey, c.member_pubkey);
            }
            db.prepare("UPDATE enterprise_keeper_changes SET status = 'applied', resolved_at = ? WHERE id = ?").run(nowIso, c.id);
        })();
    } catch (e: any) {
        if (!(e instanceof KeeperChangeRefused)) {
            // Not a reason to refuse the change — most likely a transient database error. The transaction rolled
            // back, so the change is still pending and the next scheduler tick tries again.
            console.error(`[keepers] Could not apply keeper change ${c.id}; will retry:`, e?.message || e);
            return 'retry';
        }
        outcome = 'failed';
        failReason = e?.message || String(e);
        db.transaction(() => {
            db.prepare("UPDATE enterprise_keeper_changes SET status = 'failed', resolved_at = ?, reason = ? WHERE id = ? AND status = 'pending'")
                .run(nowIso, failReason, c.id);
            if (c.request_id) {
                db.prepare("UPDATE enterprise_keeper_requests SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'")
                    .run(nowIso, c.request_id);
            }
        })();
    }

    if (outcome === 'applied') {
        if (c.kind === 'add') {
            broadcastKeeperBound(c.enterprise_pubkey, c.member_pubkey);
        } else {
            clearEnterpriseFloorCache(c.enterprise_pubkey);
            broadcast({ type: 'profile_updated', publicKey: c.member_pubkey });
            broadcast({ type: 'profile_updated', publicKey: c.enterprise_pubkey });
            broadcast({ type: 'enterprise_pledge_updated', enterprise: c.enterprise_pubkey, keeper: c.member_pubkey });
        }
    }
    broadcast({ type: 'enterprise_keeper_change_resolved', enterprisePubkey: c.enterprise_pubkey, changeId: c.id, kind: c.kind, memberPubkey: c.member_pubkey, status: outcome, reason: failReason });
    return outcome;
}

/** Apply every change whose objection window has ended (optionally for one enterprise). */
export function applyDueKeeperChanges(enterprisePubkey?: string, asOfTime?: number): { applied: number; failed: number; retrying: number } {
    const nowIso = new Date(asOfTime ?? Date.now()).toISOString();
    const rows = (enterprisePubkey
        ? db.prepare("SELECT * FROM enterprise_keeper_changes WHERE status = 'pending' AND applies_at <= ? AND enterprise_pubkey = ? ORDER BY applies_at ASC").all(nowIso, enterprisePubkey)
        : db.prepare("SELECT * FROM enterprise_keeper_changes WHERE status = 'pending' AND applies_at <= ? ORDER BY applies_at ASC").all(nowIso)) as any[];
    let applied = 0, failed = 0, retrying = 0;
    for (const c of rows) {
        // An earlier change in this batch may have closed this one (e.g. its lead was removed).
        const still = db.prepare("SELECT status FROM enterprise_keeper_changes WHERE id = ?").get(c.id) as any;
        if (still?.status !== 'pending') continue;
        const r = applyKeeperChange(c, nowIso);
        if (r === 'applied') applied++; else if (r === 'failed') failed++; else retrying++;
    }
    return { applied, failed, retrying };
}

/**
 * Any keeper may step down (answer M, 2026-09-19).
 * - The only keeper cannot: there would be nobody left to run or wind up the enterprise.
 * - A keeper whose pledge is still needed to cover the enterprise's debt cannot yet: the message says how much
 *   the debt must come down, or how much more the others must pledge, first.
 * - A lead stepping down hands the lead role on by answer G's rule (longest-serving active keeper; none → pause).
 * Their pledge is released in full (the check above guarantees the others cover any deficit).
 */
export function stepDownAsKeeper(enterprisePubkey: string, memberPubkey: string): {
    ok: true; promoted: string | null; paused: boolean; releasedBacking: number;
} {
    const ent = db.prepare("SELECT is_treasury, status FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!ent || !ent.is_treasury) throw new Error('Not an enterprise');
    if (ent.status === 'completed') throw new Error('Enterprise has already wound up');

    const op = db.prepare("SELECT role FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?")
        .get(enterprisePubkey, memberPubkey) as any;
    // A visitor's row keeps nothing to step down from, as a key with no row keeps nothing: its row stays until it joins, the
    // lead removes it, or an admin or the community does.
    if (!op || isVisitorKey(memberPubkey)) throw new Error('You are not a keeper of this enterprise');
    if (keeperBindingCount(enterprisePubkey) <= 1) {
        throw new Error('You are the only keeper. Add another keeper first, or wind the enterprise up.');
    }

    const pledge = activePledgeTotal(enterprisePubkey, memberPubkey);
    const deficit = Math.max(0, -getBalance(enterprisePubkey).balance);
    const othersCover = allowanceWithoutKeeper(enterprisePubkey, memberPubkey);
    if (pledge > 0 && othersCover < deficit) {
        const gap = Math.round((deficit - othersCover) * 100) / 100;
        const dr = Math.round(deficit * 100) / 100;
        const oc = Math.round(othersCover * 100) / 100;
        throw new Error(
            `This enterprise is ${dr} beans in debt and your pledge is part of what covers it. ` +
            `You can step down once the debt is down to ${oc} beans, or once the other keepers pledge ${gap} beans more.`
        );
    }

    let result = { promoted: null as string | null, paused: false };
    db.transaction(() => {
        unbindKeeper(enterprisePubkey, memberPubkey);
        if (op.role === 'lead') result = promoteOrPauseAfterLeadLeft(enterprisePubkey, memberPubkey);
        // A proposal naming them as the candidate is moot.
        db.prepare(`UPDATE enterprise_succession_proposals SET status = 'cancelled', closed_reason = 'candidate_gone'
                    WHERE enterprise_pubkey = ? AND candidate_pubkey = ? AND status = 'active'`).run(enterprisePubkey, memberPubkey);
    })();

    clearEnterpriseFloorCache(enterprisePubkey);
    broadcast({ type: 'profile_updated', publicKey: memberPubkey });
    broadcast({ type: 'profile_updated', publicKey: enterprisePubkey });
    if (result.promoted) broadcast({ type: 'profile_updated', publicKey: result.promoted });
    broadcast({ type: 'enterprise_pledge_updated', enterprise: enterprisePubkey, keeper: memberPubkey });
    broadcast({ type: 'enterprise_keeper_stepped_down', enterprisePubkey, memberPubkey, promoted: result.promoted, paused: result.paused });
    return { ok: true, promoted: result.promoted, paused: result.paused, releasedBacking: pledge };
}

// -------------------------------------------------------------------------------------
// Lead Succession Without an Admin (docs/the-commons.md §2.3; answers G and M, 2026-09-19)
// -------------------------------------------------------------------------------------

export interface SuccessionVoteInfo {
    voterPubkey: string;
    callsign: string;
    votedAt: string;
    choice: 'yes' | 'no';
}

export type SuccessionClosedReason = 'rejected' | 'expired' | 'lead_returned' | 'lead_changed' | 'candidate_gone';

export interface SuccessionProposalInfo {
    id: string;
    enterprisePubkey: string;
    leadPubkey: string;
    leadCallsign: string;
    candidatePubkey: string;
    candidateCallsign: string;
    proposerPubkey: string;
    proposerCallsign: string;
    status: 'active' | 'passed' | 'cancelled';
    closedReason: SuccessionClosedReason | null;
    createdAt: string;
    deadlineAt: string;
    executedAt: string | null;
    votes: SuccessionVoteInfo[];
    totalEligible: number;
    requiredVotes: number;
    /** Yes votes. */
    votesCount: number;
    noVotesCount: number;
}

/**
 * Check lead inactivity for an enterprise.
 * Activity signal: members.last_active_at (falling back to joined_at), which is automatically
 * updated whenever the lead performs authenticated node actions via recordActivity.
 *
 * `autoPromoted`: the lead got the role automatically (the community removed the previous lead, or they stepped
 * down). The other keepers may then run succession at once — answer G — so isEligible is true without the wait,
 * and the lead's own activity does not cancel a proposal.
 *
 * A visitor's lead's row (from before the visitors' rule) is eligible at once too, and its activity cancels nothing
 * (leadReturnedSince, recordActivity): it acts for the enterprise in nothing, so its keepers could otherwise add no
 * keeper and choose no lead until a Decision or an admin acted (4111202724).
 */
export function getLeadInactivity(enterprisePubkey: string): {
    leadPubkey: string | null;
    leadCallsign: string | null;
    lastActiveAt: string | null;
    daysInactive: number;
    isEligible: boolean;
    autoPromoted: boolean;
} {
    const leadRow = db.prepare(`
        SELECT o.member_pubkey, o.auto_promoted_at, m.callsign, m.last_active_at, m.joined_at, m.is_visitor
        FROM treasury_operators o
        JOIN members m ON m.public_key = o.member_pubkey
        WHERE o.treasury_pubkey = ? AND o.role = 'lead'
    `).get(enterprisePubkey) as any;

    if (!leadRow) {
        return {
            leadPubkey: null,
            leadCallsign: null,
            lastActiveAt: null,
            daysInactive: 0,
            isEligible: false,
            autoPromoted: false,
        };
    }

    const lastActiveStr = leadRow.last_active_at || leadRow.joined_at;
    const lastActiveTime = lastActiveStr ? new Date(lastActiveStr).getTime() : 0;
    const msInactive = Math.max(0, Date.now() - lastActiveTime);
    const daysInactive = msInactive / (24 * 60 * 60 * 1000);
    const autoPromoted = !!leadRow.auto_promoted_at;
    const isEligible = autoPromoted || !!leadRow.is_visitor || daysInactive >= 30;

    return {
        leadPubkey: leadRow.member_pubkey,
        leadCallsign: leadRow.callsign,
        // Served: the day and whole days only (secret ballots — see lastActiveForViewer). isEligible above
        // uses the exact time.
        lastActiveAt: lastActiveForViewer(lastActiveStr, leadRow.member_pubkey),
        daysInactive: Math.floor(daysInactive),
        isEligible,
        autoPromoted,
    };
}

function leadIsAutoPromoted(enterprisePubkey: string, leadPubkey: string): boolean {
    const r = db.prepare("SELECT auto_promoted_at FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ? AND role = 'lead'")
        .get(enterprisePubkey, leadPubkey) as any;
    return !!r?.auto_promoted_at;
}

/**
 * Has the lead a proposal targets done anything on the node since it opened? (Never, for an auto-promoted lead, nor for
 * a visitor's row, which acts for no enterprise: getLeadInactivity.)
 */
function leadReturnedSince(prop: any): boolean {
    if (leadIsAutoPromoted(prop.enterprise_pubkey, prop.lead_pubkey) || isVisitorKey(prop.lead_pubkey)) return false;
    const leadRow = db.prepare("SELECT last_active_at FROM members WHERE public_key = ?").get(prop.lead_pubkey) as any;
    return !!leadRow?.last_active_at && new Date(leadRow.last_active_at).getTime() > new Date(prop.created_at).getTime();
}

/**
 * An automatic promotion (answer G) opens the door to one succession vote, not an endless run of them. Once the
 * first proposal against the promoted lead has been decided — passed, rejected or run out of time — they are an
 * ordinary lead: the 30-day inactivity rule applies again and their own activity cancels a later proposal.
 * Every open proposal is cancelled when a lead is promoted, so any proposal against them came after the promotion.
 */
function endAutoPromotion(prop: any): void {
    db.prepare("UPDATE treasury_operators SET auto_promoted_at = NULL WHERE treasury_pubkey = ? AND member_pubkey = ? AND role = 'lead'")
        .run(prop.enterprise_pubkey, prop.lead_pubkey);
}

function closeSuccession(prop: any, reason: SuccessionClosedReason): void {
    const res = db.prepare("UPDATE enterprise_succession_proposals SET status = 'cancelled', closed_reason = ? WHERE id = ? AND status = 'active'")
        .run(reason, prop.id);
    if (reason === 'expired' && res.changes > 0) endAutoPromotion(prop);
    broadcast({ type: 'enterprise_succession_cancelled', proposalId: prop.id, enterprisePubkey: prop.enterprise_pubkey, leadPubkey: prop.lead_pubkey, reason });
}

/** Close active proposals past their 14-day deadline (optionally for one enterprise). */
export function expireSuccessionProposals(enterprisePubkey?: string, asOfTime?: number): number {
    const nowIso = new Date(asOfTime ?? Date.now()).toISOString();
    const rows = (enterprisePubkey
        ? db.prepare("SELECT * FROM enterprise_succession_proposals WHERE status = 'active' AND deadline_at <= ? AND enterprise_pubkey = ?").all(nowIso, enterprisePubkey)
        : db.prepare("SELECT * FROM enterprise_succession_proposals WHERE status = 'active' AND deadline_at <= ?").all(nowIso)) as any[];
    for (const p of rows) closeSuccession(p, 'expired');
    return rows.length;
}

/**
 * Automatically cancel any active succession proposals if the lead keeper records node activity.
 * An auto-promoted lead's activity cancels nothing (answer G), nor a visitor's row's (getLeadInactivity).
 */
export function cancelActiveSuccessionIfLeadActive(leadPubkey: string): void {
    if (isVisitorKey(leadPubkey)) return;
    const activeProps = db.prepare(
        "SELECT * FROM enterprise_succession_proposals WHERE lead_pubkey = ? AND status = 'active'"
    ).all(leadPubkey) as any[];
    for (const p of activeProps) {
        if (leadIsAutoPromoted(p.enterprise_pubkey, leadPubkey)) continue;
        closeSuccession(p, 'lead_returned');
    }
}

/** Who votes on a succession: the keepers who may act (isActiveKeeperOf), the lead aside. */
function otherActiveKeepers(enterprisePubkey: string, leadPubkey: string): string[] {
    return (db.prepare(`
        SELECT o.member_pubkey FROM treasury_operators o
        JOIN members m ON m.public_key = o.member_pubkey
        WHERE o.treasury_pubkey = ? AND o.member_pubkey != ? AND COALESCE(m.can_operate, 0) = 1 AND m.status = 'active' AND m.is_visitor = 0
    `).all(enterprisePubkey, leadPubkey) as any[]).map(r => r.member_pubkey);
}

function successionVotes(proposalId: string): SuccessionVoteInfo[] {
    return (db.prepare(`
        SELECT v.voter_pubkey, v.voted_at, v.choice, m.callsign
        FROM enterprise_succession_votes v
        JOIN members m ON m.public_key = v.voter_pubkey
        WHERE v.proposal_id = ?
        ORDER BY v.voted_at ASC
    `).all(proposalId) as any[]).map(v => ({
        voterPubkey: v.voter_pubkey,
        callsign: v.callsign,
        votedAt: v.voted_at,
        choice: v.choice === 'no' ? 'no' : 'yes',
    }));
}

function toSuccessionInfo(r: any, totalEligible: number): SuccessionProposalInfo {
    const votes = successionVotes(r.id);
    const cs = (pk: string) => getMember(pk)?.callsign || pk.slice(0, 8);
    return {
        id: r.id,
        enterprisePubkey: r.enterprise_pubkey,
        leadPubkey: r.lead_pubkey,
        leadCallsign: cs(r.lead_pubkey),
        candidatePubkey: r.candidate_pubkey,
        candidateCallsign: cs(r.candidate_pubkey),
        proposerPubkey: r.proposer_pubkey,
        proposerCallsign: cs(r.proposer_pubkey),
        status: r.status,
        closedReason: r.closed_reason ?? null,
        createdAt: r.created_at,
        deadlineAt: r.deadline_at,
        executedAt: r.executed_at ?? null,
        votes,
        totalEligible,
        requiredVotes: Math.floor(totalEligible / 2) + 1,
        votesCount: votes.filter(v => v.choice === 'yes').length,
        noVotesCount: votes.filter(v => v.choice === 'no').length,
    };
}

/**
 * Tally an active proposal and act on it, inside the caller's transaction: more than half of the other keepers
 * saying yes moves the lead role; once enough have said no that a yes majority is out of reach, it is rejected.
 */
function settleSuccession(prop: any, nowIso: string): 'passed' | 'rejected' | 'candidate_gone' | 'open' {
    const eligible = otherActiveKeepers(prop.enterprise_pubkey, prop.lead_pubkey);
    const required = Math.floor(eligible.length / 2) + 1;
    const counts = db.prepare(`
        SELECT SUM(CASE WHEN choice = 'yes' THEN 1 ELSE 0 END) AS yes, SUM(CASE WHEN choice = 'no' THEN 1 ELSE 0 END) AS no
        FROM enterprise_succession_votes WHERE proposal_id = ?
    `).get(prop.id) as any;
    const yes = Number(counts?.yes || 0);
    const no = Number(counts?.no || 0);

    if (yes >= required) {
        if (!isActiveKeeperOf(prop.enterprise_pubkey, prop.candidate_pubkey)) {
            db.prepare("UPDATE enterprise_succession_proposals SET status = 'cancelled', closed_reason = 'candidate_gone' WHERE id = ?").run(prop.id);
            return 'candidate_gone';
        }
        // Old lead becomes ordinary keeper and keeps their backing; the chosen lead is not auto-promoted.
        db.prepare("UPDATE treasury_operators SET role = 'keeper', auto_promoted_at = NULL WHERE treasury_pubkey = ? AND member_pubkey = ?")
            .run(prop.enterprise_pubkey, prop.lead_pubkey);
        db.prepare("UPDATE treasury_operators SET role = 'lead', auto_promoted_at = NULL WHERE treasury_pubkey = ? AND member_pubkey = ?")
            .run(prop.enterprise_pubkey, prop.candidate_pubkey);
        db.prepare("UPDATE enterprise_succession_proposals SET status = 'passed', executed_at = ? WHERE id = ?")
            .run(nowIso, prop.id);
        return 'passed';
    }
    if (no > eligible.length - required) {
        db.prepare("UPDATE enterprise_succession_proposals SET status = 'cancelled', closed_reason = 'rejected' WHERE id = ?").run(prop.id);
        endAutoPromotion(prop);
        return 'rejected';
    }
    return 'open';
}

function broadcastSuccessionOutcome(prop: any, outcome: ReturnType<typeof settleSuccession>, voterPubkey: string, info: SuccessionProposalInfo): void {
    if (outcome === 'passed') {
        broadcast({ type: 'enterprise_succession_passed', proposalId: prop.id, enterprisePubkey: prop.enterprise_pubkey, leadPubkey: prop.lead_pubkey, candidatePubkey: prop.candidate_pubkey, executed: true });
        broadcast({ type: 'profile_updated', publicKey: prop.enterprise_pubkey });
    } else if (outcome === 'open') {
        broadcast({ type: 'enterprise_succession_voted', proposalId: prop.id, enterprisePubkey: prop.enterprise_pubkey, voterPubkey, votesCount: info.votesCount, noVotesCount: info.noVotesCount, requiredVotes: info.requiredVotes });
    } else {
        broadcast({ type: 'enterprise_succession_cancelled', proposalId: prop.id, enterprisePubkey: prop.enterprise_pubkey, leadPubkey: prop.lead_pubkey, reason: outcome });
    }
}

/**
 * Propose moving the lead role to an active keeper.
 * Gated by: proposer is an active keeper (other than the lead), and either the lead has no activity for 30 days
 * or the lead was auto-promoted (answer G). Open for 14 days; passes on more than half of the other keepers
 * saying yes (answer M). The proposer's proposal counts as their yes.
 */
export function proposeLeadSuccession(
    enterprisePubkey: string,
    proposerPubkey: string,
    candidatePubkey: string
): { ok: true; proposal: SuccessionProposalInfo; executed: boolean } {
    const ent = db.prepare("SELECT is_treasury, status FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!ent || !ent.is_treasury) throw new Error('Not an enterprise');
    if (ent.status === 'completed') throw new Error('Completed enterprise cannot have succession');

    const inactivity = getLeadInactivity(enterprisePubkey);
    if (!inactivity.leadPubkey) {
        throw new Error('No lead keeper found for this enterprise');
    }
    const leadPubkey = inactivity.leadPubkey;

    if (!inactivity.isEligible) {
        throw new Error('Lead keeper has recorded node activity within the last 30 days');
    }

    // A visitor's lead's row is no lead to itself (getLeadInactivity): it is answered below as any key that keeps nothing.
    if (proposerPubkey === leadPubkey && !isVisitorKey(leadPubkey)) {
        throw new Error('Lead keeper cannot propose succession against themselves');
    }
    if (candidatePubkey === leadPubkey) {
        throw new Error('Candidate cannot be the current lead keeper');
    }
    if (!isActiveKeeperOf(enterprisePubkey, proposerPubkey)) {
        throw new Error('Only an active keeper of this enterprise may propose succession');
    }
    if (!isActiveKeeperOf(enterprisePubkey, candidatePubkey)) {
        throw new Error('Candidate must be an active keeper of this enterprise');
    }

    const otherKeepers = otherActiveKeepers(enterprisePubkey, leadPubkey);
    if (otherKeepers.length === 0) {
        throw new Error('No other keepers available for succession');
    }

    expireSuccessionProposals(enterprisePubkey);
    const existingActive = db.prepare(
        "SELECT * FROM enterprise_succession_proposals WHERE enterprise_pubkey = ? AND status = 'active'"
    ).get(enterprisePubkey) as any;
    if (existingActive) {
        if (leadReturnedSince(existingActive)) {
            closeSuccession(existingActive, 'lead_returned');
            throw new Error('Lead keeper has returned to activity; active proposal cancelled');
        }
        throw new Error('An active succession proposal already exists for this enterprise');
    }

    const proposalId = crypto.randomUUID();
    const now = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + SUCCESSION_WINDOW_MS).toISOString();

    let outcome = 'open' as ReturnType<typeof settleSuccession>;
    db.transaction(() => {
        db.prepare(`
            INSERT INTO enterprise_succession_proposals (id, enterprise_pubkey, lead_pubkey, candidate_pubkey, proposer_pubkey, status, created_at, deadline_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(proposalId, enterprisePubkey, leadPubkey, candidatePubkey, proposerPubkey, now, deadlineAt);
        db.prepare(`
            INSERT INTO enterprise_succession_votes (proposal_id, voter_pubkey, voted_at, choice)
            VALUES (?, ?, ?, 'yes')
        `).run(proposalId, proposerPubkey, now);
        const row = db.prepare("SELECT * FROM enterprise_succession_proposals WHERE id = ?").get(proposalId);
        outcome = settleSuccession(row, now);
    })();

    const row = db.prepare("SELECT * FROM enterprise_succession_proposals WHERE id = ?").get(proposalId) as any;
    const proposal = toSuccessionInfo(row, otherKeepers.length);
    if (outcome === 'open') {
        broadcast({ type: 'enterprise_succession_proposed', proposalId, enterprisePubkey, leadPubkey, candidatePubkey, proposerPubkey, executed: false, deadlineAt });
    } else {
        broadcastSuccessionOutcome(row, outcome, proposerPubkey, proposal);
    }
    return { ok: true, executed: outcome === 'passed', proposal };
}

/**
 * Vote yes or no on an active succession proposal (answer M).
 * Sits behind: voter is an active keeper excluding the lead, lead has not returned, deadline not passed.
 * More than half of the other keepers saying yes moves the role; enough no votes to put that out of reach rejects it.
 * A vote cannot be changed.
 */
export function voteLeadSuccession(
    proposalId: string,
    voterPubkey: string,
    choice: 'yes' | 'no' = 'yes'
): { ok: true; proposal: SuccessionProposalInfo; executed: boolean } {
    if (choice !== 'yes' && choice !== 'no') throw new Error("Vote must be 'yes' or 'no'");
    const prop = db.prepare("SELECT * FROM enterprise_succession_proposals WHERE id = ?").get(proposalId) as any;
    if (!prop) throw new Error('Succession proposal not found');
    expireSuccessionProposals(prop.enterprise_pubkey);
    const cur = db.prepare("SELECT status, closed_reason FROM enterprise_succession_proposals WHERE id = ?").get(proposalId) as any;
    if (cur.status !== 'active') {
        throw new Error(cur.closed_reason === 'expired'
            ? 'This succession proposal has passed its 14-day deadline'
            : `Proposal is no longer active (${cur.status})`);
    }

    if (leadReturnedSince(prop)) {
        closeSuccession(prop, 'lead_returned');
        throw new Error('Lead keeper has returned to activity; succession proposal was cancelled');
    }

    if (voterPubkey === prop.lead_pubkey && !isVisitorKey(prop.lead_pubkey)) {
        throw new Error('Lead keeper cannot vote on succession');
    }
    if (!isActiveKeeperOf(prop.enterprise_pubkey, voterPubkey)) {
        throw new Error('Only active keepers of this enterprise may vote on succession');
    }
    if (db.prepare("SELECT 1 FROM enterprise_succession_votes WHERE proposal_id = ? AND voter_pubkey = ?").get(proposalId, voterPubkey)) {
        throw new Error('You have already voted on this proposal');
    }

    const now = new Date().toISOString();
    let outcome = 'open' as ReturnType<typeof settleSuccession>;
    db.transaction(() => {
        db.prepare(`
            INSERT INTO enterprise_succession_votes (proposal_id, voter_pubkey, voted_at, choice)
            VALUES (?, ?, ?, ?)
        `).run(proposalId, voterPubkey, now, choice);
        outcome = settleSuccession(prop, now);
    })();

    const row = db.prepare("SELECT * FROM enterprise_succession_proposals WHERE id = ?").get(proposalId) as any;
    const proposal = toSuccessionInfo(row, otherActiveKeepers(prop.enterprise_pubkey, prop.lead_pubkey).length);
    broadcastSuccessionOutcome(prop, outcome, voterPubkey, proposal);
    if (outcome === 'candidate_gone') {
        throw new Error('Succession candidate is no longer an active keeper of this enterprise; proposal cancelled');
    }
    return { ok: true, executed: outcome === 'passed', proposal };
}

/**
 * Get lead succession proposals and eligibility for an enterprise.
 */
export function getSuccessionProposals(enterprisePubkey: string): {
    inactivity: ReturnType<typeof getLeadInactivity>;
    proposals: SuccessionProposalInfo[];
} {
    expireSuccessionProposals(enterprisePubkey);
    const inactivity = getLeadInactivity(enterprisePubkey);

    // Cancel active proposal if lead returned
    const active = db.prepare(
        "SELECT * FROM enterprise_succession_proposals WHERE enterprise_pubkey = ? AND status = 'active'"
    ).get(enterprisePubkey) as any;
    if (active && leadReturnedSince(active)) closeSuccession(active, 'lead_returned');

    const rows = db.prepare(`
        SELECT * FROM enterprise_succession_proposals
        WHERE enterprise_pubkey = ?
        ORDER BY created_at DESC
    `).all(enterprisePubkey) as any[];

    const totalEligible = inactivity.leadPubkey ? otherActiveKeepers(enterprisePubkey, inactivity.leadPubkey).length : 0;
    return { inactivity, proposals: rows.map(r => toSuccessionInfo(r, totalEligible)) };
}

/** Scheduler hook: apply keeper changes whose objection window has ended; close expired succession proposals. */
export function tickEnterpriseKeepers(asOfTime?: number): { applied: number; failed: number; expired: number } {
    const { applied, failed } = applyDueKeeperChanges(undefined, asOfTime);
    const expired = expireSuccessionProposals(undefined, asOfTime);
    return { applied, failed, expired };
}



/**
 * Record an appointed voucher's vouch for a member at a chosen level. Server-authoritative:
 * only a member holding the vouch capability (or the system admin) may vouch, and never for
 * themselves. A vouch hands out the level's credit floor (level 1 = -25, 2 = -50, 3 = -100):
 * it lifts the no-overdraft activation gate (see getMemberTrustProfile), unlocking that floor
 * plus any earned trust already banked. Monotonic — a later vouch overwrites the recorded one
 * (a re-vouch can raise or lower the level).
 */
export function vouchMember(voucherPubkey: string, targetPubkey: string, level: VouchLevel = 1): { ok: true } {
    if (voucherPubkey === targetPubkey) throw new Error('You cannot vouch for yourself');
    // A visitor's row is no voucher, as a key with no row is none (getActingMember).
    if (!getActingMember(voucherPubkey)) throw new Error('Voucher not found');
    // can_vouch outlasts a prune, and a pending re-key leaves it on the old key: neither hands out a credit floor.
    assertNodeMember(voucherPubkey);
    if (!getMember(targetPubkey)) throw new Error('Member not found');
    if (!canVouch(voucherPubkey)) throw new Error('Only appointed vouchers can vouch for members');
    const lvl: VouchLevel = level === 2 || level === 3 ? level : 1;
    const vouchCredit = vouchCreditForLevel(lvl);
    db.prepare(`UPDATE members SET elder_vouched_by = ?, vouch_credit = ? WHERE public_key = ?`).run(voucherPubkey, vouchCredit, targetPubkey);
    broadcast({ type: 'profile_updated', publicKey: targetPubkey });
    return { ok: true };
}

/**
 * Withdraw a vouch. The original voucher may withdraw their own; the system admin may
 * force-revoke anyone's. Removing a vouch removes the -20 floor, so a non-admin withdrawal
 * is blocked while the member is still carrying a negative balance (they'd be stranded below
 * the new floor of 0) — they must return to >= 0 first. Idempotent when not currently vouched.
 */
export function unvouchMember(actorPubkey: string, targetPubkey: string): { ok: true } {
    if (!getMember(targetPubkey)) throw new Error('Member not found');
    const row = db.prepare("SELECT elder_vouched_by FROM members WHERE public_key = ?").get(targetPubkey) as any;
    const vouchedBy = row?.elder_vouched_by || null;
    if (!vouchedBy) return { ok: true };
    const isAdmin = isAdminPubkey(actorPubkey);
    if (!isAdmin && actorPubkey !== vouchedBy) throw new Error('Only the voucher who vouched, or an admin, can withdraw a vouch');
    // Nor a pruned voucher, nor the old key of one being re-keyed (whose node role, if any, waits on the old key
    // until the re-key completes). An admin key with no member row at all, the legacy single-admin setting, is as before.
    if (!isAdmin || getMember(actorPubkey)) assertNodeMember(actorPubkey);
    if (!isAdmin && getBalance(targetPubkey).balance < 0) {
        throw new Error('Cannot withdraw: this member is still carrying a negative balance. They must return to 0 first.');
    }
    db.prepare(`UPDATE members SET elder_vouched_by = NULL, vouch_credit = 0 WHERE public_key = ?`).run(targetPubkey);
    broadcast({ type: 'profile_updated', publicKey: targetPubkey });
    return { ok: true };
}

export function createPost(
    type: 'offer' | 'need' | 'poll' | 'event', category: string, title: string, description: string, credits: number,
    priceType: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly' | string, authorPublicKey: string, lat?: number, lng?: number, photos?: string[], repeatable?: boolean, id?: string, cashAlsoNeeded?: boolean,
    options?: {
        reach?: unknown;
        reachPeers?: unknown;
        createdBy?: string;
        pollOptions?: Array<{ id: string; text: string }>;
        durationDays?: number;
        audienceScope?: AudienceScope;
        targetGroupId?: string;
        targetPubkey?: string;
        assignedTo?: string;
        eventStartAt?: unknown;
        eventEndAt?: unknown;
        eventPlaceName?: unknown;
        eventPrivateNote?: unknown;
    }
): MarketplacePost | null {
    credits = beansOffPrice(credits);
    const post = createPostEngine(broadcast, type, category, title, description, credits, priceType, authorPublicKey, lat, lng, photos, repeatable, id, cashAlsoNeeded, options);
    // An event or a poll posted to a group shows up in the group's chat as a card line (decision 12). The
    // acting member is named — the keeper or convenor, not an enterprise's own key.
    if (post && options?.audienceScope === 'group' && options.targetGroupId && (type === 'event' || type === 'poll')) {
        try {
            const actor = options.createdBy || authorPublicKey;
            postGroupSystemLine(getMessagingCb(), options.targetGroupId,
                type === 'event' ? GroupSystemType.EVENT_POSTED : GroupSystemType.POLL_POSTED,
                `${callsignOf(actor)} posted ${type === 'event' ? 'an event' : 'a poll'}: ${title}`,
                { postId: post.id, postType: type, actorPubkey: actor });
        } catch (e) { console.warn('[Groups] Could not write the group chat line for a new post:', e); }
    }
    return post;
}

export function getPosts(filter?: PostFilter): MarketplacePost[] {
    return getPostsEngine(db, filter);
}

export function removePost(id: string, authorPublicKey: string): boolean {
    // The push dispatcher is handed in rather than imported by the engine module (it imports this one), so
    // cancelling an event can notify everyone going (docs/events-on-the-map.md §2.2, slice 5).
    return removePostEngine(broadcast, id, authorPublicKey, dispatchPushNotification);
}

export function updatePost(id: string, authorPublicKey: string, updates: Partial<MarketplacePost> & { pollOptions?: Array<{ id: string; text: string }> }, actorPubkey?: string): MarketplacePost | null {
    if (updates.credits !== undefined) updates = { ...updates, credits: beansOffPrice(updates.credits) };
    return updatePostEngine(broadcast, id, authorPublicKey, updates, dispatchPushNotification, actorPubkey);
}

/**
 * A post's Beans price, on a node whose `beans` switch is off: none. Refused rather than quietly dropped, so an
 * author never believes they posted a price nobody will see; anything that isn't a price is stored as 0. Every
 * route that makes or edits a post comes through createPost/updatePost (marketplace, treasury, events).
 */
function beansOffPrice(credits: unknown): number {
    if (getProfileSwitches().beans) return credits as number;
    if (Number(credits) > 0) throw new BeansOffError(BEANS_OFF_PRICE_MESSAGE);
    return 0;
}

/**
 * Process pending deferred wage claims for an enterprise (docs/the-commons.md §2.4 Rule 6).
 * Automatically pays claims the moment the enterprise can legitimately pay (positive balance AND sufficient earned surplus).
 */
export function processDeferredWageClaims(enterprisePubkey: string): number {
    const ent = db.prepare('SELECT paused, status FROM members WHERE public_key = ?').get(enterprisePubkey) as any;
    if (ent?.paused === 1 || ent?.status === 'completed') {
        return 0; // While paused: no wage payments out
    }
    let paidCount = 0;
    const claims = db.prepare(`
        SELECT * FROM deferred_wage_claims
        WHERE enterprise_pubkey = ? AND status = 'pending'
        ORDER BY created_at ASC
    `).all(enterprisePubkey) as any[];

    for (const claim of claims) {
        if (claim.transaction_id) {
            const tx = db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(claim.transaction_id) as any;
            if (!tx || tx.status === 'cancelled' || tx.status === 'rejected') {
                db.prepare("UPDATE deferred_wage_claims SET status = 'cancelled' WHERE id = ?").run(claim.id);
                continue;
            }
        }
        if (claim.post_id) {
            const post = db.prepare('SELECT status FROM posts WHERE id = ?').get(claim.post_id) as any;
            if (!post || post.status === 'cancelled') {
                db.prepare("UPDATE deferred_wage_claims SET status = 'cancelled' WHERE id = ?").run(claim.id);
                continue;
            }
        }

        const { balance } = getBalance(enterprisePubkey);
        const trow = db.prepare('SELECT earned_surplus FROM members WHERE public_key = ?').get(enterprisePubkey) as any;
        const earnedSurplus = Number(trow?.earned_surplus) || 0;

        // Condition: positive balance AND sufficient earned surplus (Rule 5 & Rule 6)
        if (balance >= claim.amount && earnedSurplus >= claim.amount && balance - claim.amount >= 0) {
            let success = false;
            try {
                success = conservingTransaction(() => {
                    const memo = `Deferred wage claim payout for ${claim.post_id || 'keeper work'}`;
                    const txn = transfer(enterprisePubkey, claim.keeper_pubkey, claim.amount, memo, 'escrow', false);
                    if (!txn) return false;

                    db.prepare('UPDATE members SET earned_surplus = COALESCE(earned_surplus, 0) - ? WHERE public_key = ?')
                        .run(claim.amount, enterprisePubkey);
                    db.prepare("UPDATE deferred_wage_claims SET status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
                        .run(claim.id);

                    if (claim.transaction_id) {
                        const tx = db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(claim.transaction_id) as any;
                        if (tx?.status === 'completed') {
                            // Extra hours adjustment: base hold was already completed, increment credits by deferred diff
                            db.prepare("UPDATE marketplace_transactions SET credits = credits + ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
                                .run(claim.amount, claim.transaction_id);
                        } else {
                            db.prepare("UPDATE marketplace_transactions SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status != 'completed'")
                                .run(claim.transaction_id);
                        }
                    }
                    if (claim.post_id) {
                        db.prepare("UPDATE posts SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND repeatable = 0 AND status != 'completed'")
                            .run(claim.post_id);
                    }
                    return true;
                });
            } catch (err) {
                console.error(`[DeferredClaims] Failed to pay claim ${claim.id}:`, err);
                success = false;
            }

            if (success) {
                paidCount++;
                try {
                    broadcast({
                        type: 'deferred_wage_paid',
                        claimId: claim.id,
                        enterprise: enterprisePubkey,
                        keeper: claim.keeper_pubkey,
                        amount: claim.amount,
                    });
                } catch { }
            }
        }
    }
    return paidCount;
}

/**
 * Automatically sweeps balance above working capital ceiling to COMMONS_POOL (docs/the-commons.md §2.4 Rule 7).
 * Enterprises are decay-exempt; without a ceiling they accumulate indefinitely while members demur.
 * When balance exceeds ceiling, the excess sweeps to COMMONS_POOL via moveToCommons inside a conservingTransaction.
 */
export function sweepEnterpriseCeiling(enterprisePubkey: string): number {
    const row = db.prepare('SELECT working_capital_ceiling, is_treasury, earned_surplus FROM members WHERE public_key = ?').get(enterprisePubkey) as any;
    if (row?.is_treasury === 1 && row.working_capital_ceiling !== null && row.working_capital_ceiling !== undefined) {
        const ceiling = Number(row.working_capital_ceiling);
        if (ceiling >= 0) {
            const { balance } = getBalance(enterprisePubkey);
            const earnedSurplus = Math.max(0, Number(row.earned_surplus ?? 0));
            // THE SWEEP TAKES ONLY EARNED SURPLUS, NEVER GRANT MONEY (docs/the-commons.md §2.4 Rule 7).
            // sweepable = max(0, min(balance − working_capital_ceiling, earned_surplus))
            const excess = Math.round(Math.max(0, Math.min(balance - ceiling, earnedSurplus)) * 100) / 100;
            if (excess > 0) {
                let sweptTxn: Transaction | null = null;
                try {
                    sweptTxn = conservingTransaction(() => {
                        const txn = moveToCommons(
                            enterprisePubkey,
                            excess,
                            `Surplus swept to Commons above working capital ceiling (${ceiling} Beans)`
                        );
                        db.prepare('UPDATE members SET earned_surplus = MAX(0, COALESCE(earned_surplus, 0) - ?) WHERE public_key = ?')
                            .run(excess, enterprisePubkey);
                        return txn;
                    });
                } catch (err) {
                    console.error(`[EnterpriseCeiling] Failed to sweep ${excess} beans from ${enterprisePubkey}:`, err);
                }
                if (sweptTxn) {
                    try {
                        broadcast({
                            type: 'enterprise_ceiling_swept',
                            enterprise: enterprisePubkey,
                            amount: excess,
                            ceiling,
                        });
                    } catch { }
                    return excess;
                }
            }
        }
    }
    return 0;
}

export { recordDeferredWageClaim } from './engine/escrow.js';

// ===================== ENTERPRISE LIFECYCLE (PAUSE, WIND-UP, LEDGER) =====================

/**
 * Pause an enterprise for a season (docs/the-commons.md §2.2).
 * Authorised by canAdministerTreasury (a keeper or node admin).
 * Takes a snapshot of the current credit floor (paused_floor_snapshot).
 * Idempotent. Records auth_signer.
 */
export function pauseEnterprise(enterprisePubkey: string, actorPubkey: string): {
    ok: true;
    paused: boolean;
    pausedAt?: string;
    pausedFloorSnapshot?: number;
    alreadyPaused?: boolean;
} {
    const member = db.prepare("SELECT is_treasury, paused, paused_at, paused_floor_snapshot, status FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!member || !member.is_treasury) throw new Error('Not an enterprise');
    if (member.status === 'completed') throw new Error('Enterprise has wound up — account closed');
    if (!canAdministerTreasury(actorPubkey, enterprisePubkey)) {
        throw new Error('Not authorised to pause this enterprise');
    }

    if (member.paused === 1) {
        return {
            ok: true,
            paused: true,
            pausedAt: member.paused_at,
            pausedFloorSnapshot: member.paused_floor_snapshot != null ? Number(member.paused_floor_snapshot) : undefined,
            alreadyPaused: true,
        };
    }

    const currentUsable = usableFloor(enterprisePubkey);
    const { floor: underlyingFloor } = getEnterpriseUnderlyingFloor(enterprisePubkey);
    const snapshot = currentUsable !== 0 ? currentUsable : underlyingFloor;

    const now = new Date().toISOString();
    db.prepare(`
        UPDATE members
        SET paused = 1, paused_at = ?, paused_by = ?, paused_floor_snapshot = ?
        WHERE public_key = ?
    `).run(now, actorPubkey, snapshot, enterprisePubkey);

    broadcast({ type: 'profile_updated', publicKey: enterprisePubkey });
    broadcast({ type: 'enterprise_paused', enterprisePubkey, pausedBy: actorPubkey, pausedAt: now, snapshot });

    return {
        ok: true,
        paused: true,
        pausedAt: now,
        pausedFloorSnapshot: snapshot,
    };
}

/**
 * Resume a paused enterprise (docs/the-commons.md §2.2).
 * Clears the credit floor snapshot; floor recomputes normally.
 * Idempotent.
 */
export function resumeEnterprise(enterprisePubkey: string, actorPubkey: string): {
    ok: true;
    paused: boolean;
    alreadyActive?: boolean;
} {
    const member = db.prepare("SELECT is_treasury, paused, status FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!member || !member.is_treasury) throw new Error('Not an enterprise');
    if (member.status === 'completed') throw new Error('Enterprise has wound up — cannot be resumed');
    if (!canAdministerTreasury(actorPubkey, enterprisePubkey)) {
        throw new Error('Not authorised to resume this enterprise');
    }

    if (member.paused === 0 || member.paused == null) {
        return {
            ok: true,
            paused: false,
            alreadyActive: true,
        };
    }

    db.prepare(`
        UPDATE members
        SET paused = 0, paused_at = NULL, paused_by = NULL, paused_floor_snapshot = NULL
        WHERE public_key = ?
    `).run(enterprisePubkey);

    broadcast({ type: 'profile_updated', publicKey: enterprisePubkey });
    broadcast({ type: 'enterprise_resumed', enterprisePubkey, resumedBy: actorPubkey });

    return {
        ok: true,
        paused: false,
    };
}

/**
 * Set an enterprise's map location (docs/the-commons.md §2.2, §2.3, Slice 6).
 * Only keepers or an admin can set or clear location.
 * Range CHECK is enforced (-90 <= lat <= 90, -180 <= lng <= 180).
 * Recorded with auth_signer.
 */
export function setEnterpriseLocation(
    enterprisePubkey: string,
    actorPubkey: string,
    location: { lat: number | null; lng: number | null } | null
): {
    ok: true;
    lat: number | null;
    lng: number | null;
    locationAuthSigner: string;
    locationUpdatedAt: string;
} {
    const member = db.prepare("SELECT is_treasury, status FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!member || !member.is_treasury) throw new Error('Not an enterprise');
    if (member.status === 'completed') throw new Error('Enterprise has wound up — cannot update location');
    if (!canAdministerTreasury(actorPubkey, enterprisePubkey)) {
        throw new Error('Only a keeper of this enterprise (or node admin) may set its location');
    }

    let latVal: number | null = null;
    let lngVal: number | null = null;

    if (location && (location.lat != null || location.lng != null)) {
        if (location.lat == null || location.lng == null) {
            throw new Error('Both latitude and longitude must be provided');
        }
        const lat = Number(location.lat);
        const lng = Number(location.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            throw new Error('Latitude and longitude must be valid numbers');
        }
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            throw new Error('Latitude must be between -90 and 90, longitude between -180 and 180');
        }
        latVal = lat;
        lngVal = lng;
    }

    return writeEnterpriseLocation(enterprisePubkey, actorPubkey, latVal, lngVal);
}

function writeEnterpriseLocation(enterprisePubkey: string, actorPubkey: string, latVal: number | null, lngVal: number | null) {
    const now = new Date().toISOString();
    db.prepare(`
        UPDATE members
        SET lat = ?, lng = ?, location_auth_signer = ?, auth_signer = ?, location_updated_at = ?, updated_at = ?
        WHERE public_key = ?
    `).run(latVal, lngVal, actorPubkey, actorPubkey, now, now, enterprisePubkey);

    broadcast({ type: 'profile_updated', publicKey: enterprisePubkey });
    broadcast({ type: 'enterprise_location_updated', enterprisePubkey, lat: latVal, lng: lngVal, authSigner: actorPubkey, updatedAt: now });

    return {
        ok: true as const,
        lat: latVal,
        lng: lngVal,
        locationAuthSigner: actorPubkey,
        locationUpdatedAt: now,
    };
}

/**
 * Clear an enterprise's map location (docs/the-commons.md §2.2, §2.3, Slice 6).
 * Only keepers or an admin can clear location.
 * Recorded with auth_signer.
 *
 * A completed (wound-up) enterprise can still be cleared, by a node admin only: its keepers were released at
 * wind-up, and a location left behind must never be stuck (PR #839 Blocker A). Setting one stays refused.
 */
export function clearEnterpriseLocation(
    enterprisePubkey: string,
    actorPubkey: string
): {
    ok: true;
    lat: null;
    lng: null;
    locationAuthSigner: string;
    locationUpdatedAt: string;
} {
    const member = db.prepare("SELECT is_treasury, status FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (member?.is_treasury && member.status === 'completed') {
        if (!(actorPubkey === 'admin' || actorPubkey === 'owner:password' || isAdminPubkey(actorPubkey))) {
            throw new Error('Only a node admin may clear the location of a wound-up enterprise');
        }
        return writeEnterpriseLocation(enterprisePubkey, actorPubkey, null, null) as any;
    }
    return setEnterpriseLocation(enterprisePubkey, actorPubkey, null) as any;
}

/**
 * Step 1 of Enterprise Wind-up: Lead keeper initiates wind-up with 7-day grace period.
 * (docs/the-commons.md §2.2, mirroring §3.8).
 * Sets status to 'winding_up'.
 */
export function initiateWindUp(enterprisePubkey: string, actorPubkey: string): {
    ok: true;
    status: 'winding_up';
    initiatedAt: string;
    initiatedBy: string;
    graceEndsAt: string;
    alreadyInitiated?: boolean;
} {
    const member = db.prepare("SELECT is_treasury, status, wind_up_initiated_at, wind_up_initiated_by FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!member || !member.is_treasury) throw new Error('Not an enterprise');
    if (member.status === 'completed') throw new Error('Enterprise has already wound up');

    if (!isLeadOrSoleKeeperOrAdmin(enterprisePubkey, actorPubkey)) {
        throw new Error('Only the lead keeper may initiate wind-up');
    }

    const currentBal = getBalance(enterprisePubkey).balance;
    if (currentBal < 0) {
        throw new Error('Cannot wind up an enterprise in deficit — debt must be resolved or written off first');
    }

    if (member.status === 'winding_up') {
        const graceEndsAt = new Date(new Date(member.wind_up_initiated_at).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        return {
            ok: true,
            status: 'winding_up',
            initiatedAt: member.wind_up_initiated_at,
            initiatedBy: member.wind_up_initiated_by,
            graceEndsAt,
            alreadyInitiated: true,
        };
    }

    const now = new Date().toISOString();
    const graceEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
        UPDATE members
        SET status = 'winding_up', wind_up_initiated_at = ?, wind_up_initiated_by = ?
        WHERE public_key = ?
    `).run(now, actorPubkey, enterprisePubkey);

    broadcast({ type: 'profile_updated', publicKey: enterprisePubkey });
    broadcast({ type: 'enterprise_winding_up', enterprisePubkey, initiatedBy: actorPubkey, initiatedAt: now, graceEndsAt });

    return {
        ok: true,
        status: 'winding_up',
        initiatedAt: now,
        initiatedBy: actorPubkey,
        graceEndsAt,
    };
}

/**
 * Cancel wind-up during the 7-day grace period.
 * Any keeper may cancel (§2.2, mirroring §3.8). Resets status to 'active'.
 */
export function cancelWindUp(enterprisePubkey: string, actorPubkey: string): {
    ok: true;
    status: 'active';
} {
    const member = db.prepare("SELECT is_treasury, status, wind_up_initiated_at FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!member || !member.is_treasury) throw new Error('Not an enterprise');
    if (member.status === 'completed') throw new Error('Enterprise has already wound up');
    if (member.status !== 'winding_up') throw new Error('Enterprise is not winding up');

    if (!canOperateTreasury(actorPubkey, enterprisePubkey) && !isAdminPubkey(actorPubkey)) {
        throw new Error('Only a keeper of this enterprise may cancel wind-up');
    }

    db.prepare(`
        UPDATE members
        SET status = 'active', wind_up_initiated_at = NULL, wind_up_initiated_by = NULL
        WHERE public_key = ?
    `).run(enterprisePubkey);

    broadcast({ type: 'profile_updated', publicKey: enterprisePubkey });
    broadcast({ type: 'enterprise_wind_up_cancelled', enterprisePubkey, cancelledBy: actorPubkey });

    return {
        ok: true,
        status: 'active',
    };
}

/**
 * Step 2 of Enterprise Wind-up: Finalise after 7-day grace period and 0 open escrows.
 * Sweeps remaining balance to Commons inside conservingTransaction.
 * Releases all operators in treasury_operators and backing pledges.
 * Status -> 'completed'. Name stays reserved.
 */
export function finaliseWindUp(enterprisePubkey: string, actorPubkey: string): {
    ok: true;
    status: 'completed';
    finalisedAt: string;
    sweptAmount: number;
    alreadyCompleted?: boolean;
} {
    const member = db.prepare("SELECT is_treasury, status, wind_up_initiated_at, wind_up_finalised_at FROM members WHERE public_key = ?").get(enterprisePubkey) as any;
    if (!member || !member.is_treasury) throw new Error('Not an enterprise');
    if (member.status === 'completed') {
        return {
            ok: true,
            status: 'completed',
            finalisedAt: member.wind_up_finalised_at || new Date().toISOString(),
            sweptAmount: 0,
            alreadyCompleted: true,
        };
    }
    if (member.status !== 'winding_up') {
        throw new Error('Enterprise must be in winding_up state to finalise');
    }

    if (!isLeadOrSoleKeeperOrAdmin(enterprisePubkey, actorPubkey)) {
        throw new Error('Only the lead keeper may finalise wind-up');
    }

    const initiatedAt = member.wind_up_initiated_at ? new Date(member.wind_up_initiated_at).getTime() : 0;
    const gracePeriodMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - initiatedAt < gracePeriodMs) {
        throw new Error('Cannot finalise wind-up before 7-day grace period has elapsed');
    }

    const currentBal = getBalance(enterprisePubkey).balance;
    if (currentBal < 0) {
        throw new Error('Cannot wind up an enterprise in deficit — debt must be resolved or written off first');
    }

    // Deliberately OUTSIDE conservingTransaction. This is an ordinary precondition — a keeper
    // finalising while trades are still open is a normal thing to do, not an exceptional one — and
    // conservingTransaction treats any throw as a possible conservation breach: it rolls back and
    // then runs a full reconcileLedgerFromDb() to resync memory to rows, halting the process if
    // that resync fails. Rebuilding the in-memory ledger every time someone clicks finalise too
    // early is a steep price for a 400. The atomicity it would buy is illusory anyway: the sweep
    // re-reads the balance inside the transaction, and the transaction holds the write lock, so no
    // escrow can open between this check and the sweep.
    const openEscrows = db.prepare(`
        SELECT COUNT(*) as c FROM marketplace_transactions
        WHERE (buyer_pubkey = ? OR seller_pubkey = ?) AND status IN ('requested', 'pending', 'disputed')
    `).get(enterprisePubkey, enterprisePubkey) as any;
    if ((openEscrows?.c ?? 0) > 0) {
        throw new Error(`Cannot finalise wind-up: ${openEscrows.c} open transaction(s) pending settlement`);
    }

    let sweptAmount = 0;
    let hadLocation = false;
    const now = new Date().toISOString();

    conservingTransaction(() => {
        const bal = ledger.getAccount(enterprisePubkey).balance;
        if (bal > 0) {
            const swept = moveToCommons(enterprisePubkey, bal, `Final wind-up sweep from ${enterprisePubkey.slice(0, 8)}`, { authSigner: actorPubkey });
            if (!swept) throw new Error('Failed to sweep remaining balance to Commons');
            sweptAmount = bal;
        }

        const ops = db.prepare("SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = ?").all(enterprisePubkey) as any[];
        db.prepare("DELETE FROM treasury_operators WHERE treasury_pubkey = ?").run(enterprisePubkey);

        for (const op of ops) {
            const remaining = db.prepare("SELECT COUNT(*) as c FROM treasury_operators WHERE member_pubkey = ?").get(op.member_pubkey) as any;
            if (!remaining?.c) {
                db.prepare("UPDATE members SET can_operate = 0 WHERE public_key = ?").run(op.member_pubkey);
            }
        }

        db.prepare("UPDATE enterprise_pledges SET released_at = ? WHERE enterprise = ? AND released_at IS NULL").run(now, enterprisePubkey);
        clearEnterpriseFloorCache(enterprisePubkey);

        // A wound-up enterprise's map location goes with it (PR #839 Blocker A): a keeper may have pinned it
        // on their own house, and once it is completed nobody keeps it any more. The clear is signed by the
        // finalising actor, exactly as a keeper's own clear would be.
        //
        // Only when there WAS a location to clear (#839 review note): an enterprise that was never pinned kept
        // no location signer, and stamping one here recorded a location change that never happened.
        hadLocation = !!(db.prepare("SELECT 1 FROM members WHERE public_key = ? AND (lat IS NOT NULL OR lng IS NOT NULL)").get(enterprisePubkey));
        db.prepare(`
            UPDATE members
            SET status = 'completed', wind_up_finalised_at = ?,
                legacy_credit_floor = NULL,
                paused = 0, paused_at = NULL, paused_by = NULL, paused_floor_snapshot = NULL
            WHERE public_key = ?
        `).run(now, enterprisePubkey);
        if (hadLocation) {
            db.prepare(`
                UPDATE members
                SET lat = NULL, lng = NULL, location_auth_signer = ?, auth_signer = ?, location_updated_at = ?
                WHERE public_key = ?
            `).run(actorPubkey, actorPubkey, now, enterprisePubkey);
        }

        db.prepare(`
            UPDATE deferred_wage_claims
            SET status = 'cancelled'
            WHERE enterprise_pubkey = ? AND status = 'pending'
        `).run(enterprisePubkey);

        db.prepare(`
            UPDATE posts
            SET status = 'cancelled', active = 0
            WHERE author_pubkey = ? AND status IN ('active', 'pending')
        `).run(enterprisePubkey);
    });

    broadcast({ type: 'profile_updated', publicKey: enterprisePubkey });
    if (hadLocation) {
        broadcast({ type: 'enterprise_location_updated', enterprisePubkey, lat: null, lng: null, authSigner: actorPubkey, updatedAt: now });
    }
    broadcast({ type: 'enterprise_wound_up', enterprisePubkey, finalisedBy: actorPubkey, finalisedAt: now, sweptAmount });

    return {
        ok: true,
        status: 'completed',
        finalisedAt: now,
        sweptAmount,
    };
}

export interface EnterpriseLedgerEntry {
    id: string;
    timestamp: string;
    direction: 'income' | 'spend';
    amount: number;
    fee: number;
    netAmount: number;
    counterparty: string;
    counterpartyName: string;
    memo: string;
    runningBalance: number;
    /** Who signed, in words: a callsign or "a community admin"; never a key or 'owner:password'. */
    authSigner: string | null;
}

export interface EnterpriseLedgerSummary {
    totalIncome: number;
    totalSpend: number;
    netChange: number;
    startingBalance: number;
    endingBalance: number;
    transactionCount: number;
}

export interface EnterpriseLedgerResponse {
    enterprise: {
        publicKey: string;
        name: string;
        purpose: string | null;
        status: string;
        paused: boolean;
        balance: number;
    };
    period: {
        since: string | null;
        until: string | null;
    };
    summary: EnterpriseLedgerSummary;
    entries: EnterpriseLedgerEntry[];
}

/**
 * Read-only accountability ledger (docs/the-commons.md §2.2).
 * Accessible to any member of the node.
 * Resolves counterparties to display names.
 * Computes running totals directly from the transactions table. Excludes nothing.
 */
export function getEnterpriseLedger(
    enterprisePubkey: string,
    opts?: { since?: string; until?: string; limit?: number }
): EnterpriseLedgerResponse {
    const member = db.prepare("SELECT callsign, purpose, status, paused FROM members WHERE public_key = ? AND is_treasury = 1").get(enterprisePubkey) as any;
    if (!member) throw new Error('Not an enterprise');

    const allTxns = db.prepare(`
        SELECT id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp, auth_signer
        FROM transactions
        WHERE from_pubkey = ? OR to_pubkey = ?
        ORDER BY timestamp ASC, rowid ASC
    `).all(enterprisePubkey, enterprisePubkey) as any[];

    const sinceTime = opts?.since ? new Date(opts.since).getTime() : null;
    const untilTime = opts?.until ? new Date(opts.until).getTime() : null;

    let running = 0;
    let startingBalance = 0;
    let periodIncome = 0;
    let periodSpend = 0;
    const filteredEntries: EnterpriseLedgerEntry[] = [];

    const nameCache = new Map<string, string>();
    const resolveName = (pk: string): string => {
        if (nameCache.has(pk)) return nameCache.get(pk)!;
        let resolved = pk;
        if (pk === 'COMMONS_POOL') resolved = 'Commons Pool';
        else if (pk === 'genesis') resolved = 'Genesis';
        else if (pk.startsWith('escrow_')) {
            const postId = pk.replace('escrow_', '');
            const post = db.prepare('SELECT title FROM posts WHERE id = ?').get(postId) as any;
            resolved = post?.title ? `Escrow: ${post.title}` : 'Escrow';
        } else if (pk.startsWith('bridge_')) {
            resolved = `Federation Bridge (${pk.replace('bridge_', '')})`;
        } else {
            const m = db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(pk) as any;
            resolved = m?.callsign || (pk.length > 12 ? `${pk.slice(0, 8)}...` : pk);
        }
        nameCache.set(pk, resolved);
        return resolved;
    };

    let periodEndingBalance = 0;

    for (const tx of allTxns) {
        const txTime = new Date(tx.timestamp).getTime();
        const isIncoming = tx.to_pubkey === enterprisePubkey;
        const fee = Number(tx.tax_fee) || 0;
        const gross = Number(tx.amount) || 0;
        const netAmount = isIncoming ? (gross - fee) : -gross;

        running = Math.round((running + netAmount) * 100) / 100;

        const inPeriod = (!sinceTime || txTime >= sinceTime) && (!untilTime || txTime <= untilTime);

        if (sinceTime && txTime < sinceTime) {
            startingBalance = running;
        }

        if (inPeriod) {
            if (isIncoming) {
                periodIncome += gross;
            } else {
                periodSpend += gross;
            }
            periodEndingBalance = running;

            const counterparty = isIncoming ? tx.from_pubkey : tx.to_pubkey;
            filteredEntries.push({
                id: tx.id,
                timestamp: tx.timestamp,
                direction: isIncoming ? 'income' : 'spend',
                amount: gross,
                fee,
                netAmount: Math.round(netAmount * 100) / 100,
                counterparty,
                counterpartyName: resolveName(counterparty),
                memo: tx.memo || '',
                runningBalance: running,
                // Who signed, in words. For an arbitrated deal the raw signer is the ruling admin's key or
                // 'owner:password'; anyone who can read this book reads the name only. The column keeps the signer.
                authSigner: tx.auth_signer ? adminActorName(tx.auth_signer) : null,
            });
        }
    }

    if (filteredEntries.length === 0) {
        periodEndingBalance = startingBalance;
    }

    const currentBal = getBalance(enterprisePubkey).balance;
    const entries = opts?.limit ? filteredEntries.slice(-opts.limit) : filteredEntries;

    return {
        enterprise: {
            publicKey: enterprisePubkey,
            name: member.callsign,
            purpose: member.purpose ?? null,
            status: member.status ?? 'active',
            paused: member.paused === 1,
            balance: currentBal,
        },
        period: {
            since: opts?.since ?? null,
            until: opts?.until ?? null,
        },
        summary: {
            totalIncome: Math.round(periodIncome * 100) / 100,
            totalSpend: Math.round(periodSpend * 100) / 100,
            netChange: Math.round((periodEndingBalance - startingBalance) * 100) / 100,
            startingBalance: Math.round(startingBalance * 100) / 100,
            endingBalance: Math.round(periodEndingBalance * 100) / 100,
            transactionCount: filteredEntries.length,
        },
        entries,
    };
}

export function closePoll(postId: string, authorPublicKey: string): MarketplacePost | null {
    return closePollEngine(broadcast, postId, authorPublicKey);
}

export function votePoll(
    postId: string,
    voterPublicKey: string,
    optionId: string,
    signature?: string
): { success: boolean; post: MarketplacePost } {
    return votePollEngine(broadcast, postId, voterPublicKey, optionId, signature);
}

export function rsvpEvent(
    postId: string,
    memberPublicKey: string,
    status: 'going' | 'interested' | null,
    signature?: string
): { success: boolean; post: MarketplacePost } {
    return rsvpEventEngine(broadcast, postId, memberPublicKey, status, signature);
}
// ===================== MARKETPLACE TRANSACTIONS =====================

function getEscrowCb() {
    return {
        broadcast,
        transfer,
        ensureTransactionConversation,
        injectSystemMessage,
        dispatchPushNotification,
        getBalance,
        floorLockedError,
        SystemMessageType,
        canOperateTreasury,
        conservingTransaction,
        processDeferredWageClaims,
        sweepEnterpriseCeiling,
    };
}

export function requestPost(postId: string, requesterPublicKey: string, hours?: number): MarketplaceTransaction {
    return requestPostEngine(getEscrowCb(), postId, requesterPublicKey, hours);
}

export function approvePostRequest(transactionId: string, authorPublicKey: string, opts?: { authSigner?: string }): MarketplaceTransaction | null {
    return approvePostRequestEngine(getEscrowCb(), transactionId, authorPublicKey, opts);
}

export function rejectPostRequest(transactionId: string, authorPublicKey: string): MarketplaceTransaction | null {
    return rejectPostRequestEngine(getEscrowCb(), transactionId, authorPublicKey);
}

export function cancelPostRequest(transactionId: string, requesterPublicKey: string): MarketplaceTransaction | null {
    return cancelPostRequestEngine(getEscrowCb(), transactionId, requesterPublicKey);
}

export function acceptPost(postId: string, buyerPublicKey: string, hours?: number, opts?: { authSigner?: string }): MarketplaceTransaction {
    return acceptPostEngine(getEscrowCb(), postId, buyerPublicKey, hours, opts);
}

export function completePostTransaction(transactionId: string, confirmerPublicKey: string, finalHours?: number, opts?: { authSigner?: string }): MarketplaceTransaction & { alreadyCompleted?: boolean } | null {
    const res = completePostTransactionEngine(getEscrowCb(), transactionId, confirmerPublicKey, finalHours, opts);
    if (res) clearEnterpriseFloorCache();
    return res;
}

export function cancelPostTransaction(transactionId: string, cancellerPublicKey: string): MarketplaceTransaction | null {
    return cancelPostTransactionEngine(getEscrowCb(), transactionId, cancellerPublicKey);
}

export type { EscrowDisputeAction };

export function resolveEscrowDispute(
    transactionId: string,
    action: EscrowDisputeAction,
    adminSigner: string,
    opts?: { reason?: string }
): MarketplaceTransaction {
    const res = resolveEscrowDisputeEngine(getEscrowCb(), transactionId, action, adminSigner, opts);
    clearEnterpriseFloorCache();
    return res;
}

export interface EscrowDisputeContext {
    id: string;
    postId: string;
    credits: number;
    hours?: number;
    status: string;
    createdAt: string;
    daysInEscrow: number;
    daysStuck: number;
    isStalled: boolean;
    buyerPubkey: string;
    sellerPubkey: string;
    buyerCallsign?: string;
    sellerCallsign?: string;
    resolution?: EscrowDisputeAction | null;
    resolvedAt?: number | null;
    resolvedBy?: string | null;
    disputeResolution?: EscrowDisputeAction | null;
    disputeResolvedAt?: string | null;
    disputeResolvedBy?: string | null;
    post: {
        id: string;
        title: string;
        description: string;
        type: string;
        category: string;
        priceType: string;
        credits: number;
        authorPubkey: string;
        photos: string[];
    } | null;
    parties: {
        buyer: {
            pubkey: string;
            callsign: string;
            avatarUrl?: string | null;
        };
        seller: {
            pubkey: string;
            callsign: string;
            avatarUrl?: string | null;
        };
    };
    chat?: {
        conversationId: string | null;
        messages: Message[];
    };
    chatContext: {
        id: string;
        senderPubkey: string;
        recipientPubkey?: string;
        senderCallsign?: string;
        content: string;
        createdAt: number;
        type?: string;
    }[];
}

function mapDisputeRow(r: any): EscrowDisputeContext {
    const createdTime = new Date(r.created_at).getTime();
    const now = Date.now();
    const daysInEscrow = Math.max(0, (now - createdTime) / (86400 * 1000));
    const isStalled = daysInEscrow >= 7;

    const photos = (db.prepare('SELECT order_num, updated_at FROM post_photos WHERE post_id = ? ORDER BY order_num ASC').all(r.post_id) as any[])
        .map(p => `/api/marketplace/posts/${r.post_id}/photos/${p.order_num}?v=${p.updated_at ? new Date(p.updated_at).getTime() : 0}`);

    // Chat context between buyer and seller
    const convRow = db.prepare(`
        SELECT c.id FROM conversations c
        JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.public_key = ?
        JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.public_key = ?
        LIMIT 1
    `).get(r.buyer_pubkey, r.seller_pubkey) as any;

    let chat: { conversationId: string | null; messages: Message[] } | undefined = undefined;
    if (convRow?.id) {
        const msgs = getConversationMessages(convRow.id, 50, 0);
        chat = {
            conversationId: convRow.id,
            messages: msgs
        };
    }

    const chatContext = (chat?.messages || []).map(m => ({
        id: m.id,
        senderPubkey: m.authorPubkey,
        recipientPubkey: m.authorPubkey === r.buyer_pubkey ? r.seller_pubkey : r.buyer_pubkey,
        senderCallsign: m.authorPubkey === r.buyer_pubkey ? (r.buyer_callsign || 'Buyer') : (m.authorPubkey === r.seller_pubkey ? (r.seller_callsign || 'Seller') : 'System'),
        content: m.ciphertext,
        createdAt: new Date(m.timestamp).getTime(),
        type: m.type
    }));

    return {
        id: r.id,
        postId: r.post_id,
        credits: r.credits,
        hours: r.hours ?? undefined,
        status: r.status,
        createdAt: r.created_at,
        daysInEscrow,
        daysStuck: Math.floor(daysInEscrow),
        isStalled,
        buyerPubkey: r.buyer_pubkey,
        sellerPubkey: r.seller_pubkey,
        buyerCallsign: r.buyer_callsign || 'Anonymous',
        sellerCallsign: r.seller_callsign || 'Anonymous',
        resolution: r.dispute_resolution || null,
        resolvedAt: r.dispute_resolved_at ? new Date(r.dispute_resolved_at).getTime() : null,
        resolvedBy: r.dispute_resolved_by ? adminActorName(r.dispute_resolved_by) : null,
        disputeResolution: r.dispute_resolution || null,
        disputeResolvedAt: r.dispute_resolved_at || null,
        disputeResolvedBy: r.dispute_resolved_by ? adminActorName(r.dispute_resolved_by) : null,
        post: (r.post_title || r.post_id) ? {
            id: r.post_id,
            title: r.post_title || 'Untitled Post',
            description: r.post_description || '',
            type: r.post_type || 'offer',
            category: r.post_category || 'general',
            priceType: r.post_price_type || 'fixed',
            credits: r.post_credits ?? r.credits,
            authorPubkey: r.post_author_pubkey || r.seller_pubkey,
            photos
        } : null,
        parties: {
            buyer: {
                pubkey: r.buyer_pubkey,
                callsign: r.buyer_callsign || 'Anonymous',
                avatarUrl: r.buyer_avatar_url || null
            },
            seller: {
                pubkey: r.seller_pubkey,
                callsign: r.seller_callsign || 'Anonymous',
                avatarUrl: r.seller_avatar_url || null
            }
        },
        chat,
        chatContext
    };
}

export function getEscrowDisputes(minDays = 7, limit = 50, offset = 0, status: 'all' | 'pending' | 'resolved' = 'all'): EscrowDisputeContext[] {
    let query = `
        SELECT mt.*,
               p.title AS post_title,
               p.description AS post_description,
               p.type AS post_type,
               p.category AS post_category,
               p.price_type AS post_price_type,
               p.credits AS post_credits,
               p.author_pubkey AS post_author_pubkey,
               buyer.callsign AS buyer_callsign,
               buyer.avatar_url AS buyer_avatar_url,
               seller.callsign AS seller_callsign,
               seller.avatar_url AS seller_avatar_url
        FROM marketplace_transactions mt
        LEFT JOIN posts p ON mt.post_id = p.id
        LEFT JOIN members buyer ON mt.buyer_pubkey = buyer.public_key
        LEFT JOIN members seller ON mt.seller_pubkey = seller.public_key
        WHERE ((? = 'all' AND (mt.status = 'pending' OR mt.dispute_resolution IS NOT NULL))
           OR (? = 'resolved' AND mt.dispute_resolution IS NOT NULL)
           OR (? = 'pending' AND mt.status = 'pending'))
    `;
    const params: any[] = [status, status, status];
    if (minDays > 0) {
        query += ` AND (julianday('now') - julianday(mt.created_at)) >= ?`;
        params.push(minDays);
    }
    query += ` ORDER BY mt.created_at ASC LIMIT ? OFFSET ?`;
    params.push(Math.max(1, Math.min(200, limit)), Math.max(0, offset));

    const rows = db.prepare(query).all(...params) as any[];
    return rows.map(mapDisputeRow);
}

/** How many disputes each Escrow Disputes tab holds; same filters as getEscrowDisputes. */
export function countEscrowDisputes(minDays = 7): { pending: number; resolved: number; all: number } {
    const row = db.prepare(`
        SELECT COALESCE(SUM(mt.status = 'pending'), 0) AS pending,
               COALESCE(SUM(mt.dispute_resolution IS NOT NULL), 0) AS resolved,
               COALESCE(SUM(mt.status = 'pending' OR mt.dispute_resolution IS NOT NULL), 0) AS all_count
        FROM marketplace_transactions mt
        WHERE (? <= 0 OR (julianday('now') - julianday(mt.created_at)) >= ?)
    `).get(minDays, minDays) as any;
    return { pending: row.pending, resolved: row.resolved, all: row.all_count };
}

export function getEscrowDispute(transactionId: string): EscrowDisputeContext | null {
    const row = db.prepare(`
        SELECT mt.*,
               p.title AS post_title,
               p.description AS post_description,
               p.type AS post_type,
               p.category AS post_category,
               p.price_type AS post_price_type,
               p.credits AS post_credits,
               p.author_pubkey AS post_author_pubkey,
               buyer.callsign AS buyer_callsign,
               buyer.avatar_url AS buyer_avatar_url,
               seller.callsign AS seller_callsign,
               seller.avatar_url AS seller_avatar_url
        FROM marketplace_transactions mt
        LEFT JOIN posts p ON mt.post_id = p.id
        LEFT JOIN members buyer ON mt.buyer_pubkey = buyer.public_key
        LEFT JOIN members seller ON mt.seller_pubkey = seller.public_key
        WHERE mt.id = ?
    `).get(transactionId) as any;

    if (!row) return null;
    return mapDisputeRow(row);
}

export function pausePost(postId: string, authorPublicKey: string): boolean {
    return pausePostEngine(broadcast, postId, authorPublicKey);
}

export function resumePost(postId: string, authorPublicKey: string): boolean {
    return resumePostEngine(broadcast, postId, authorPublicKey);
}

export function getMarketplaceTransaction(transactionId: string): MarketplaceTransaction | null {
    return getMarketplaceTransactionEngine(db, transactionId);
}

export function getMarketplaceTransactions(publicKey: string, filter?: { status?: string }, limit = 50, offset = 0): MarketplaceTransaction[] {
    return getMarketplaceTransactionsEngine(db, publicKey, filter, limit, offset);
}

// ===================== COMMUNITY INFO =====================

export function getCommunityInfo(publicKey?: string): { memberCount: number; postCount: number; transactionCount: number; commonsBalance: number; currency: { type: string, value: string }; profile: NodeProfile; features: NodeFeatures } {
    const memberCount = (db.prepare("SELECT COUNT(*) as c FROM members WHERE status != 'pruned'").get() as any).c;
    const postCount = getActivePostCount();
    let txCount = 0;
    if (publicKey) {
        txCount = (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE from_pubkey = ? OR to_pubkey = ?").get(publicKey, publicKey) as any).c;
    } else {
        txCount = (db.prepare("SELECT COUNT(*) as c FROM transactions").get() as any).c;
    }
    const config = getLocalConfig();
    // profile + features are additive: the apps read them to know what this node does; older apps ignore them.
    return {
        memberCount, postCount, transactionCount: txCount, commonsBalance: Math.round(COMMONS_BALANCE * 100) / 100,
        currency: { type: config.currencyType || 'image', value: config.currencyValue || 'bean' },
        profile: getNodeProfile(), features: getNodeFeatures(),
    };
}

/**
 * O(1) count of live, listable posts — the same set getPosts({}) returns (active AND
 * status in active/pending), so it EXCLUDES paused posts. Intentionally narrower than
 * getCommunityInfo().postCount (which counts all active=1, paused included).
 */
export function getActivePostCount(): number {
    return getActivePostCountEngine(db);
}

// ===================== MESSAGING =====================

function getMessagingCb() {
    return {
        broadcast,
        dispatchPushNotification,
        registerVisitor
    };
}

export function createConversation(type: 'dm', participants: string[], createdBy: string, name?: string): Conversation | null {
    return createConversationEngine(getMessagingCb(), type, participants, createdBy, name);
}

export function sendMessage(conversationId: string, authorPubkey: string, ciphertext: string, nonce: string, type: 'text' | 'image' = 'text', attachment?: { data: string; nonce: string; mime?: string }, metadata?: string, clientId?: string): Message | null {
    return sendMessageEngine(getMessagingCb(), conversationId, authorPubkey, ciphertext, nonce, type, attachment, metadata, clientId);
}

export function toggleMessageReaction(messageId: string, authorPubkey: string, emoji: string): any {
    return toggleMessageReactionEngine(getMessagingCb(), messageId, authorPubkey, emoji);
}

export function editMessage(messageId: string, authorPubkey: string, ciphertext: string, nonce: string): Message {
    return editMessageEngine(getMessagingCb(), messageId, authorPubkey, ciphertext, nonce);
}

export function deleteOwnMessage(messageId: string, authorPubkey: string): Message {
    return deleteOwnMessageEngine(getMessagingCb(), messageId, authorPubkey);
}

export { MESSAGE_EDIT_WINDOW_MS };

export function injectSystemMessage(postId: string, type: SystemMessageTypeVal | string, meta: TypedMessagePayload, buyerPubkey?: string, sellerPubkey?: string): void {
    return injectSystemMessageEngine(getMessagingCb(), postId, type, meta, buyerPubkey, sellerPubkey);
}

export function getConversationsByMember(pubkey: string): Conversation[] {
    return getConversationsByMemberEngine(db, pubkey);
}

export function getConversationMessages(conversationId: string, limit = 50, offset = 0): Message[] {
    return getConversationMessagesEngine(db, conversationId, limit, offset);
}

export function getConversation(id: string): Conversation | undefined {
    return getConversationEngine(db, id);
}

export function markConversationRead(pubkey: string, conversationId: string): void {
    return markConversationReadEngine(pubkey, conversationId);
}

export function getUnreadCounts(pubkey: string): Record<string, number> {
    return getUnreadCountsEngine(db, pubkey);
}

/**
 * A member's unread counts over the chats their conversation list shows: an event's chat is left out while the event
 * is hidden from them by reports (G3, chatHiddenFrom). GET /api/messages/conversations and the badge every push
 * carries both read this, so the number on the app icon is always one the member can open and clear.
 */
export function getListedUnreadCounts(pubkey: string): Record<string, number> {
    const counts = getUnreadCounts(pubkey);
    const typeOf = db.prepare('SELECT type FROM conversations WHERE id = ?');
    for (const id of Object.keys(counts)) {
        const conv = typeOf.get(id) as { type: string } | undefined;
        if (conv && chatHiddenFrom({ id, type: conv.type }, pubkey)) delete counts[id];
    }
    return counts;
}

export function ensureTransactionConversation(postId: string, buyerPubkey: string, sellerPubkey: string): string {
    return ensureTransactionConversationEngine(getMessagingCb(), postId, buyerPubkey, sellerPubkey);
}

export function migrateConsolidateConversations(): void {
    return migrateConsolidateConversationsEngine(getMessagingCb());
}

export function repairConsolidatedMessagesMetadata(): void {
    return repairConsolidatedMessagesMetadataEngine();
}

export function ensureEnterpriseThread(enterprisePubkey: string): Conversation {
    return ensureEnterpriseThreadEngine(enterprisePubkey);
}

export function getEnterpriseThreadMessages(enterprisePubkey: string, limit = 50, offset = 0): EnterpriseThreadMessage[] {
    return getEnterpriseThreadMessagesEngine(enterprisePubkey, limit, offset);
}

export function postEnterpriseThreadMessage(enterprisePubkey: string, authorPubkey: string, text: string, clientId?: string): EnterpriseThreadMessage {
    return postEnterpriseThreadMessageEngine(getMessagingCb(), enterprisePubkey, authorPubkey, text, clientId);
}

export function removeEnterpriseThreadMessage(enterprisePubkey: string, messageId: string, actorPubkey: string): EnterpriseThreadMessage {
    return removeEnterpriseThreadMessageEngine(getMessagingCb(), enterprisePubkey, messageId, actorPubkey);
}

export function isKeeperOfEnterprise(actorPubkey: string, enterprisePubkey: string): boolean {
    return isKeeperOfEnterpriseEngine(actorPubkey, enterprisePubkey);
}

export type { EnterpriseThreadMessage };

// ===================== EVENT CHAT (docs/events-on-the-map.md §2.2) =====================

export function getEventThread(postId: string, viewerPubkey: string | undefined, limit = 50, offset = 0): EventThreadView {
    return getEventThreadEngine(postId, viewerPubkey, limit, offset);
}

export function postEventThreadMessage(postId: string, authorPubkey: string, text: string, clientId?: string): EventThreadMessage {
    return postEventThreadMessageEngine(getMessagingCb(), postId, authorPubkey, text, clientId);
}

export function removeEventThreadMessage(postId: string, messageId: string, actorPubkey: string): EventThreadMessage {
    return removeEventThreadMessageEngine(getMessagingCb(), postId, messageId, actorPubkey);
}

export type { EventThreadMessage, EventThreadView };

// ===================== STATE SYNC =====================

export type {
    PostPhoto,
    Project,
    SyncAccount,
    SyncFriend,
    SyncConversationParticipant,
    SyncConversation,
    SyncAbuseReport,
    SyncRecoveryRequest,
    SyncRecoveryApproval,
    SyncMarketplaceTransaction,
    SyncPollVote,
    SyncPayload,
    ImportResult,
    NodeRole
};

export { getNodeRole, setNodeRole, getSyncCursor, setSyncCursor, recordSyncAttempt, getCurrentImportOrigin, writeSyncAuditLog };
export type { SyncAuditEntry };

export function getStateHash(): string {
    return getStateHashEngine(db);
}

function getSyncCb() {
    return {
        getPrivateKey,
        publicKeyToProtobuf,
        publicKeyFromProtobuf,
        loadLedgerState: (accs: any[]) => ledger.loadState(accs),
        setCommonsBalance: (bal: number) => setCommonsBalance(bal),
        broadcast
    };
}

export function exportSyncState(nodeId: string, since?: string | null): Promise<SyncPayload> {
    return exportSyncStateWrapper(getSyncCb(), nodeId, since, COMMONS_BALANCE);
}

export function signSyncPayload(payload: SyncPayload): Promise<SyncPayload> {
    return signSyncPayloadEngine(getSyncCb(), payload);
}

/**
 * `full`: the payload is a whole copy of the main server (the puller's snapshot), not a delta. Only a whole copy shows
 * which recovery copies the main server no longer holds.
 */
export function importRemoteState(remote: SyncPayload, opts: { full?: boolean } = {}): Promise<ImportResult> {
    // An import writes the ledger from outside the money guards, so "this ledger has never moved" is looked at again.
    return importRemoteStateEngine(getSyncCb(), remote)
        .then((result) => {
            // A standby clears its database of recovery copies deleted before the seal once its main server has sealed,
            // and at a whole copy removes the copies that server deleted before it; after a rollback past the seal (a new
            // seal epoch from its main server, or copies sent in the client's form after it cleared), it clears again
            // (services/recovery-seal-key.ts). Never throws.
            clearCopiesDroppedBeforeSeal({
                standby: getNodeRole() === 'backup',
                wholeCopy: opts.full && Array.isArray(remote.recoveryShares) ? remote.recoveryShares : null,
                imported: Array.isArray(remote.recoveryShares) ? remote.recoveryShares : null,
                mainEpoch: remote.sealEpoch,
            });
            return result;
        })
        .finally(forgetLedgerHistory);
}
// ===================== RATINGS =====================

export { addRating, addFriend, removeFriend };

export function getRatings(targetPubkey: string): any[] {
    return getRatingsEngine(db, targetPubkey);
}

export function getRatingsGiven(raterPubkey: string): Rating[] {
    return getRatingsGivenEngine(db, raterPubkey);
}

export function getAverageRating(targetPubkey: string) {
    return getAverageRatingEngine(db, targetPubkey);
}

// ===================== FRIENDS =====================

export function getFriends(pubkey: string): FriendEntry[] {
    return getFriendsEngine(db, pubkey);
}

// ===================== ABUSE REPORTS =====================

/** Reports one member may file in a rolling hour. Each report is a replicated row every operator reads. */
export const REPORTS_PER_REPORTER_PER_HOUR = 10;

/**
 * The reporter's still-pending report on exactly this target (member, post and Pulse item alike),
 * or null. A second report on the same thing adds nothing an operator does not already have.
 */
export function findPendingReport(reporterPubkey: string, targetPubkey: string, targetPostId?: string, targetPulseItemId?: string): AbuseReport | null {
    const row = db.prepare(
        `SELECT id, reporter_pubkey, target_pubkey, target_post_id, target_pulse_item_id, reason, created_at
           FROM abuse_reports
          WHERE reporter_pubkey = ? AND target_pubkey = ?
            AND target_post_id IS ? AND target_pulse_item_id IS ?
            AND (status = 'pending' OR status IS NULL)
          ORDER BY created_at ASC LIMIT 1`
    ).get(reporterPubkey, targetPubkey, targetPostId || null, targetPulseItemId || null) as any;
    if (!row) return null;
    return {
        id: row.id, reporterPubkey: row.reporter_pubkey, targetPubkey: row.target_pubkey,
        targetPostId: row.target_post_id ?? undefined, targetPulseItemId: row.target_pulse_item_id ?? undefined,
        reason: row.reason, createdAt: row.created_at, status: 'pending',
    };
}

/** True once the reporter has filed REPORTS_PER_REPORTER_PER_HOUR reports in the last hour. */
export function isReportRateLimited(reporterPubkey: string, now: number = Date.now()): boolean {
    const since = new Date(now - 60 * 60 * 1000).toISOString();
    const row = db.prepare(`SELECT COUNT(*) AS c FROM abuse_reports WHERE reporter_pubkey = ? AND created_at > ?`)
        .get(reporterPubkey, since) as { c: number };
    return row.c >= REPORTS_PER_REPORTER_PER_HOUR;
}

export function submitReport(reporterPubkey: string, targetPubkey: string, reason: string, targetPostId?: string, targetPulseItemId?: string): AbuseReport | null {
    // A member of this node, not just a row: a pruned account, or a re-keyed phone's old key, reports nobody.
    if (!isNodeMember(reporterPubkey) || reporterPubkey === targetPubkey) return null;
    const existing = findPendingReport(reporterPubkey, targetPubkey, targetPostId, targetPulseItemId);
    if (existing) return existing;
    const safeReason = typeof reason === 'string' ? reason.slice(0, 500) : String(reason ?? '').slice(0, 500);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, target_pulse_item_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, reporterPubkey, targetPubkey, targetPostId || null, targetPulseItemId || null, safeReason, createdAt);
    // On the global profile, enough established reporters hide the post until a moderator looks (G3). A report of
    // a member or a Pulse item never hides anything.
    if (targetPostId && !targetPulseItemId) evaluateAutoHide(moderationNoticeCb, targetPostId);
    return { id, reporterPubkey, targetPubkey, targetPostId, targetPulseItemId, reason: safeReason, createdAt, status: 'pending' };
}

/**
 * The owner of a live Pulse item, for reporting it. Null when the item does not exist or is
 * already tombstoned — there is nothing left on the feed to report.
 */
export function getReportablePulseItemOwner(itemId: string): string | null {
    const row = db.prepare('SELECT owner_pubkey FROM pulse_items WHERE id = ? AND deleted_at IS NULL').get(itemId) as { owner_pubkey: string } | undefined;
    return row?.owner_pubkey ?? null;
}

export function getReports(statusFilter?: string, limit?: number, offset?: number): { reports: AbuseReport[]; total: number; pendingCount: number } {
    let whereClause = '';
    const params: any[] = [];

    if (statusFilter && statusFilter !== 'all') {
        if (statusFilter === 'pending') {
            whereClause = "WHERE ar.status = 'pending' OR ar.status IS NULL";
        } else {
            whereClause = 'WHERE ar.status = ?';
            params.push(statusFilter);
        }
    }

    const countSql = `SELECT COUNT(*) as c FROM abuse_reports ar ${whereClause}`;
    const total = (db.prepare(countSql).get(...params) as any)?.c || 0;

    const pendingCount = (db.prepare("SELECT COUNT(*) as c FROM abuse_reports WHERE status = 'pending' OR status IS NULL").get() as any)?.c || 0;

    let querySql = `
        SELECT ar.*, 
               mr.callsign as reporter_callsign, 
               mt.callsign as target_callsign,
               p.title as post_title, substr(p.description, 1, 500) as post_description,
               p.id as post_row_id, p.active as post_active, p.status as post_status,
               p.hidden_by_reports_at as post_hidden_at,
               mp.callsign as post_author_callsign,
               pi.title as pulse_title, pi.platform as pulse_platform, pi.url as pulse_url,
               pi.deleted_at as pulse_deleted_at
        FROM abuse_reports ar
        LEFT JOIN members mr ON ar.reporter_pubkey = mr.public_key
        LEFT JOIN members mt ON ar.target_pubkey = mt.public_key
        LEFT JOIN posts p ON ar.target_post_id = p.id
        LEFT JOIN members mp ON p.author_pubkey = mp.public_key
        LEFT JOIN pulse_items pi ON ar.target_pulse_item_id = pi.id
        ${whereClause}
        ORDER BY ar.created_at DESC
    `;

    const queryParams = [...params];
    if (typeof limit === 'number' && limit > 0) {
        querySql += ' LIMIT ?';
        queryParams.push(limit);
        if (typeof offset === 'number' && offset >= 0) {
            querySql += ' OFFSET ?';
            queryParams.push(offset);
        }
    }

    const rows = db.prepare(querySql).all(...queryParams) as any[];
    const reports = rows.map(r => ({ 
        id: r.id, reporterPubkey: r.reporter_pubkey, targetPubkey: r.target_pubkey, 
        targetPostId: r.target_post_id, reason: r.reason, createdAt: r.created_at,
        status: r.status || 'pending',
        outcome: (r.status === 'reviewed' ? 'dismissed' : r.status === 'actioned' ? 'actioned' : 'open') as AbuseReport['outcome'],
        reporterCallsign: r.reporter_callsign || (r.reporter_pubkey ? `@${r.reporter_pubkey.substring(0, 8)}` : 'Unknown Member'),
        targetCallsign: r.target_callsign || (r.target_pubkey ? `@${r.target_pubkey.substring(0, 8)}` : 'Unknown Member'),
        postTitle: r.post_title || null,
        title: r.post_title || null,
        // The reported post, for a moderation list (fields added; the ones above are unchanged for old callers).
        // Only a real post: the phone app files an enterprise report with the enterprise's key in targetPostId.
        postId: r.post_row_id || null,
        postAuthorCallsign: r.post_row_id ? (r.post_author_callsign || null) : null,
        // What the post says (its first 500 characters), so whoever triages the report can judge it from the report.
        postDescription: r.post_row_id ? (r.post_description ?? null) : null,
        // A post the admins or its author already took down.
        postRemoved: r.post_row_id ? (r.post_active !== 1 || r.post_status === 'cancelled') : null,
        // Hidden by reports, waiting for a moderator (G3): restore it or remove it.
        postHiddenByReports: r.post_row_id ? !!r.post_hidden_at : null,
        targetPulseItemId: r.target_pulse_item_id || undefined,
        pulseItem: r.target_pulse_item_id
            ? {
                title: r.pulse_title ?? null,
                platform: r.pulse_platform ?? 'unknown',
                url: r.pulse_url ?? null,
                // A missing row (never replicated here) counts as removed: there is nothing to act on.
                removed: !r.pulse_platform || r.pulse_deleted_at !== null,
            }
            : null,
    }));

    return { reports, total, pendingCount };
}

export function getReportCount(): number {
    return (db.prepare("SELECT COUNT(*) as c FROM abuse_reports WHERE status = 'pending' OR status IS NULL").get() as any).c;
}

/**
 * Aggregated per-member stats for the Audit tree.
 * Returns one row per member with post counts, message counts, trade volume, and escrow cancellation counts.
 * Single-pass SQL — no per-member queries needed on the frontend.
 */
export function getMemberStats(): Record<string, { posts: number; messages: number; deals: number; volume: number; cancelled: number }> {
    const rows = db.prepare(`
        SELECT m.public_key,
            COALESCE(p.post_count, 0) as post_count,
            COALESCE(msg.msg_count, 0) as msg_count,
            COALESCE(d.deal_count, 0) as deal_count,
            COALESCE(d.volume, 0) as volume,
            COALESCE(d.cancelled_count, 0) as cancelled_count
        FROM members m
        LEFT JOIN (
            SELECT author_pubkey, COUNT(*) as post_count 
            FROM posts WHERE active = 1 
            GROUP BY author_pubkey
        ) p ON m.public_key = p.author_pubkey
        LEFT JOIN (
            SELECT author_pubkey, COUNT(*) as msg_count 
            FROM messages WHERE author_pubkey != 'SYSTEM' 
            GROUP BY author_pubkey
        ) msg ON m.public_key = msg.author_pubkey
        LEFT JOIN (
            SELECT pubkey,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as deal_count,
                SUM(CASE WHEN status = 'completed' THEN credits ELSE 0 END) as volume,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count
            FROM (
                SELECT buyer_pubkey as pubkey, status, credits FROM marketplace_transactions
                UNION ALL
                SELECT seller_pubkey as pubkey, status, credits FROM marketplace_transactions
            ) combined
            GROUP BY pubkey
        ) d ON m.public_key = d.pubkey
    `).all() as any[];

    const stats: Record<string, { posts: number; messages: number; deals: number; volume: number; cancelled: number }> = {};
    for (const r of rows) {
        stats[r.public_key] = {
            posts: r.post_count,
            messages: r.msg_count,
            deals: r.deal_count,
            volume: Math.round(r.volume * 100) / 100,
            cancelled: r.cancelled_count
        };
    }
    return stats;
}

export function dismissReport(reportId: string): boolean {
    const report = db.prepare("SELECT reporter_pubkey, target_post_id, status FROM abuse_reports WHERE id = ?").get(reportId) as any;
    // updated_at moves with status: the sync export selects on it, and without the bump replicas keep
    // showing the report as pending.
    const res = db.prepare("UPDATE abuse_reports SET status = 'reviewed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(reportId);
    // Its reporter hears the post was reviewed and kept — once, when an open report is dismissed. If the
    // author had already taken it down, "kept" would be untrue: they hear it is no longer up.
    const post = report?.target_post_id ? db.prepare('SELECT active, status FROM posts WHERE id = ?').get(report.target_post_id) as any : null;
    // A hidden post whose remaining reports no longer add up to a hide is visible again (G3), before the reporter
    // is told it was kept.
    if (res.changes > 0 && report?.target_post_id) recheckHiddenPost(moderationNoticeCb, report.target_post_id);
    if (res.changes > 0 && post && (report.status === 'pending' || report.status == null)) {
        notifyReportDismissed(moderationNoticeCb, report.reporter_pubkey, report.target_post_id, post.active === 1 && post.status !== 'cancelled');
    }
    return res.changes > 0;
}

/**
 * A moderator restores a post hidden by reports (G3): visible to everyone again, and every open report on it
 * dismissed, so those reporters hear it was kept and cannot hide it again.
 */
export function restoreHiddenPost(postId: string): 'restored' | 'not_hidden' | 'not_found' {
    return restoreHiddenPostEngine(moderationNoticeCb, postId);
}

/** A moderator lifts a member's mute (G3). False when they were not muted. */
export function liftModerationMute(pubkey: string): boolean {
    return liftMuteEngine(moderationNoticeCb, pubkey);
}

export function actionReport(
    reportId: string,
    deletePost: boolean = false,
    suspendUser: boolean = false,
    removePulseItem: boolean = false,
    opts?: { reasonCategory?: string | null; onRefundShortfall?: (s: EscrowRefundShortfall) => void },
): boolean {
    // Notices go out after the commit, never from inside it: a rollback must not leave a member told of a removal.
    let takedown: { post: NonNullable<ReturnType<typeof removePostByAdmin>>; reporters: string[] } | null = null;
    // Refund shortfalls are held back for the same reason. This is the report flow — the path a moderator
    // actually uses — so a buyer refunded less than the trade row said has to reach the moderator here too,
    // not just the two direct removal routes; a shortfall only `console.warn` knows about is how the
    // rows-vs-ledger discrepancy stays invisible. Reported only once the removal has actually committed.
    const shortfalls: EscrowRefundShortfall[] = [];
    // The member suspended, announced after the commit as an admin's suspension is (adminSetUserStatus): their standing
    // changed, and their open sockets are asked again on it (deliverBroadcast), so they stop getting the member feed.
    let suspended: string | null = null;
    const ok = db.transaction(() => {
        const report = db.prepare("SELECT * FROM abuse_reports WHERE id = ?").get(reportId) as any;
        if (!report) return false;
        const wasOpen = report.status === 'pending' || report.status == null;
        
        db.prepare("UPDATE abuse_reports SET status = 'actioned', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(reportId);
        
        if (deletePost && report.target_post_id) {
            const removed = removePostByAdmin(report.target_post_id, s => shortfalls.push(s), true);
            if (removed) {
                const reporters = closeOpenReportsOnPost(report.target_post_id);
                if (wasOpen) reporters.push(report.reporter_pubkey);
                takedown = { post: removed, reporters };
            }
        }

        // Tombstoned exactly as the owner's own delete does. The member is not penalised unless
        // suspendUser is also set. The caller evicts the cached thumbnail, as the owner route does.
        if (removePulseItem && report.target_pulse_item_id) {
            scrubPulseItems({ id: report.target_pulse_item_id });
        }

        if (suspendUser && report.target_pubkey) {
            // #172 CR: Update updated_at timestamp so delta-sync watermarks pick up the status change
            db.prepare("UPDATE members SET status = 'suspended', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?").run(report.target_pubkey);
            try { db.prepare("DELETE FROM node_roles WHERE member_pubkey = ?").run(report.target_pubkey); } catch { }
            noteTakeoverInputsChanged('member suspended by a report');
            // #172 CR: Pause all active posts of the suspended member so other members cannot initiate deals
            db.prepare("UPDATE posts SET active = 0, status = 'paused', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE author_pubkey = ? AND active = 1").run(report.target_pubkey);
            bumpMembersVersion();
            bumpPostsVersion();
            suspended = report.target_pubkey;
        }
        return true;
    })();
    const suspendedKey = suspended as string | null;
    if (ok && suspendedKey) broadcast({ type: 'profile_updated', publicKey: suspendedKey });
    const done = takedown as { post: NonNullable<ReturnType<typeof removePostByAdmin>>; reporters: string[] } | null;
    if (ok && done) {
        notifyPostTakedown(moderationNoticeCb, done.post, done.reporters, normaliseRemovalReason(opts?.reasonCategory));
        // The third removal in 30 days mutes its author on the global profile (G3).
        if (done.post.wasLive) evaluateAutoMute(moderationNoticeCb, done.post.authorPubkey);
    }
    if (ok) for (const shortfall of shortfalls) opts?.onRefundShortfall?.(shortfall);
    return ok;
}

/**
 * Prune Stale Posts. Each removal closes its open reports, as a single removal does, but nobody is told per
 * post: each author hears once, with the count, that this was routine tidying, not a takedown.
 */
export function adminBulkDeletePosts(postIds: string[], opts?: { onRefundShortfall?: (s: EscrowRefundShortfall) => void }): number {
    const removed: NonNullable<ReturnType<typeof removePostByAdmin>>[] = [];
    const reportersByPost = new Map<string, string[]>();
    for (const postId of postIds) {
        const r = removePostByAdmin(postId, opts?.onRefundShortfall);
        if (!r) continue;
        removed.push(r);
        reportersByPost.set(postId, closeOpenReportsOnPost(postId));
    }
    notifyPostsCleared(moderationNoticeCb, removed, reportersByPost);
    return removed.length;
}

export function getPostCount(filter?: {
    type?: string;
    category?: string;
    status?: string;
    query?: string;
    audienceScope?: AudienceScope | string;
    viewerPubkey?: string;
    targetGroupId?: string;
}): number {
    return getPostCountEngine(db, filter);
}

// ===================== COMMUNITY HEALTH =====================

export interface HealthFlag { type: 'wash_trading' | 'isolated_branch' | 'inactive_member' | 'invite_spam' | 'sybil_funnel' | 'sybil_ring' | 'aggregate_spike' | 'cohort_velocity' | 'delinquency' | 'watchdog_recovery' | 'watchdog_down' | 'unhandled_rejections'; severity: 'warning' | 'alert' | 'critical'; description: string; members: string[]; }
export interface WatchdogStatus { present: boolean; lastSeenAt: string | null; status: string | null; recoveries: number; lastRecoveryAt: string | null; healthy: boolean; }
export interface CommunityHealth { nodeName: string; version: string; minAppVersion: string; appVersions: AppStoreVersions; currency: { type: string; value: string }; tree: any; activity: any; flags: HealthFlag[]; reportCount: number; watchdog: WatchdogStatus; }

// Reads the host watchdog's status file (dropped into the data dir by
// ops/watchdog). Absent file = no watchdog on this host (not an error). A file
// whose heartbeat is older than WATCHDOG_STALE_MS means a watchdog was running
// and has since died — worth surfacing so the fleet knows a node lost its guard.
const WATCHDOG_STALE_MS = 5 * 60 * 1000;
function readWatchdogStatus(): WatchdogStatus {
    const empty: WatchdogStatus = { present: false, lastSeenAt: null, status: null, recoveries: 0, lastRecoveryAt: null, healthy: false };
    try {
        const dataDir = process.env.BEANPOOL_DATA_DIR || join(process.cwd(), 'data');
        const file = join(dataDir, 'watchdog-status.json');
        if (!existsSync(file)) return empty;
        const s = JSON.parse(readFileSync(file, 'utf-8'));
        const lastSeenAt = typeof s.lastSeenAt === 'string' ? s.lastSeenAt : null;
        const seenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
        const healthy = Number.isFinite(seenMs) && (Date.now() - seenMs) < WATCHDOG_STALE_MS;
        return {
            present: true,
            lastSeenAt,
            status: typeof s.status === 'string' ? s.status : null,
            recoveries: Number.isFinite(s.recoveries) ? s.recoveries : 0,
            lastRecoveryAt: typeof s.lastRecoveryAt === 'string' ? s.lastRecoveryAt : null,
            healthy,
        };
    } catch { return empty; }
}

export function getCommunityHealth(): CommunityHealth {
    const now = Date.now();
    const t = getThresholds();
    
    // Active vs Inactive member counts (excluding genesis admin account)
    let activeMemberCount = 0;
    let inactiveMemberCount = 0;
    try {
        activeMemberCount = (db.prepare(`
            SELECT COUNT(DISTINCT m.public_key) as c 
            FROM members m 
            WHERE m.status != 'pruned' AND m.invited_by != 'genesis' AND (
                m.joined_at > datetime('now', '-${t.inactiveMemberDays} days') OR
                m.public_key IN (
                    SELECT DISTINCT from_pubkey FROM transactions WHERE timestamp > datetime('now', '-${t.inactiveMemberDays} days')
                    UNION
                    SELECT DISTINCT to_pubkey FROM transactions WHERE timestamp > datetime('now', '-${t.inactiveMemberDays} days')
                )
            )
        `).get() as any).c;
        
        inactiveMemberCount = (db.prepare(`
            SELECT COUNT(DISTINCT m.public_key) as c 
            FROM members m 
            WHERE m.status != 'pruned' AND m.invited_by != 'genesis' AND
            m.joined_at <= datetime('now', '-${t.inactiveMemberDays} days') AND
            m.public_key NOT IN (
                SELECT DISTINCT from_pubkey FROM transactions WHERE timestamp > datetime('now', '-${t.inactiveMemberDays} days')
                UNION
                SELECT DISTINCT to_pubkey FROM transactions WHERE timestamp > datetime('now', '-${t.inactiveMemberDays} days')
            )
        `).get() as any).c;
    } catch (e) { console.error('Failed to calculate member activity stats:', e); }

    // ⚡ O(1) SQL count instead of materialising every member row to read .length
    const totalMembers = (db.prepare("SELECT COUNT(*) as c FROM members WHERE status != 'pruned'").get() as any).c;
    
    // ========== HEALTH FLAG DETECTION ==========
    const flags: HealthFlag[] = [];
    
    // 1. Inactive Members: no transactions in N days, and must have joined > N days ago
    try {
        const inactiveRows = db.prepare(`
            SELECT m.public_key, m.callsign FROM members m 
            WHERE m.status = 'active' AND m.invited_by != 'genesis'
            AND m.joined_at <= datetime('now', '-${t.inactiveMemberDays} days')
            AND m.public_key NOT IN (
                SELECT DISTINCT from_pubkey FROM transactions WHERE timestamp > datetime('now', '-${t.inactiveMemberDays} days')
                UNION
                SELECT DISTINCT to_pubkey FROM transactions WHERE timestamp > datetime('now', '-${t.inactiveMemberDays} days')
            )
        `).all() as any[];
        if (inactiveRows.length > 0) {
            flags.push({
                type: 'inactive_member',
                severity: 'warning',
                description: `${inactiveRows.length} member${inactiveRows.length > 1 ? 's' : ''} with no activity for ${t.inactiveMemberDays}+ days`,
                members: inactiveRows.map(r => r.public_key)
            });
        }
    } catch (e) { console.error('Health flag check (inactive) failed:', e); }
    
    // 2. Wash Trading / Sybil Ring soft enforcement (Change 3)
    try {
        const enforcement = getWashTradingEnforcement();
        // Callsigns only for members who can appear in a flag. A healthy community has none, so
        // the common path reads no member rows at all (#673); a flagged one reads just those keys.
        const ringsToName = enforcement.clusterDetails.filter(d => d.insularity >= 0.8 && d.newRatio >= 0.5);
        const keysToName = new Set<string>([
            ...[...enforcement.flaggedPairs].flatMap(pairKey => pairKey.split('|')),
            ...ringsToName.flatMap(d => d.members),
        ]);
        const callsignsMap = new Map<string, string>(keysToName.size === 0 ? [] :
            (db.prepare("SELECT public_key, callsign FROM members WHERE public_key IN (SELECT value FROM json_each(?))")
                .all(JSON.stringify([...keysToName])) as any[]).map(m => [m.public_key, m.callsign]));
        for (const pairKey of enforcement.flaggedPairs) {
            const [a, b] = pairKey.split('|');
            // Skip if all involved accounts are already credit-frozen by admin
            const frozenCount = (db.prepare("SELECT COUNT(*) as cnt FROM members WHERE public_key IN (?, ?) AND credit_frozen = 1").get(a, b) as any)?.cnt || 0;
            if (frozenCount >= 2) continue;

            const callsignA = callsignsMap.get(a) || a.substring(0, 8);
            const callsignB = callsignsMap.get(b) || b.substring(0, 8);
            const details = enforcement.pairDetails.find(p => (p.a === a && p.b === b) || (p.a === b && p.b === a));
            const gross = details ? details.gross : 0;
            const r = details ? details.r : 0;
            flags.push({
                type: 'wash_trading',
                severity: 'alert',
                description: `Wash trading detected: reciprocal flow ratio ${r.toFixed(3)} < 0.15 for pair ${callsignA} ↔ ${callsignB} (gross: ${gross.toFixed(1)})`,
                members: [a, b]
            });
        }
        for (const detail of enforcement.clusterDetails) {
            if (detail.insularity >= 0.8 && detail.newRatio >= 0.5) {
                // Skip if all members of the ring are already credit-frozen by admin
                const placeholders = detail.members.map(() => '?').join(',');
                const frozenCount = (db.prepare(`SELECT COUNT(*) as cnt FROM members WHERE public_key IN (${placeholders}) AND credit_frozen = 1`).get(...detail.members) as any)?.cnt || 0;
                if (frozenCount >= detail.members.length) continue;

                const names = detail.members.map((m: string) => {
                    return callsignsMap.get(m) || m.substring(0, 8);
                }).join(', ');
                flags.push({
                    type: 'sybil_ring',
                    severity: 'critical',
                    description: `Suspected Sybil ring: component of ${detail.size} members with ${detail.insularity.toFixed(2)} insularity and ${(detail.newRatio * 100).toFixed(0)}% new members (${names})`,
                    members: detail.members
                });
            }
        }
    } catch (e) { console.error('Health flag check (wash trading / sybil ring) failed:', e); }

    // 3. Sybil Funnel: invitees purchasing from their inviter via marketplace
    try {
        // Primary: completed marketplace deals where buyer was invited by seller
        const funnelRows = db.prepare(`
            SELECT 
                seller.public_key as farmer_pubkey,
                seller.callsign as farmer_callsign,
                COUNT(DISTINCT mt.buyer_pubkey) as puppet_count,
                ROUND(SUM(mt.credits), 2) as total_funneled,
                GROUP_CONCAT(DISTINCT buyer.callsign) as puppet_names,
                GROUP_CONCAT(DISTINCT buyer.public_key) as puppet_keys
            FROM marketplace_transactions mt
            JOIN members buyer ON mt.buyer_pubkey = buyer.public_key
            JOIN members seller ON mt.seller_pubkey = seller.public_key
            WHERE buyer.invited_by = seller.public_key
              AND mt.status = 'completed'
              AND mt.created_at > datetime('now', ? || ' days')
            GROUP BY seller.public_key
            HAVING puppet_count >= ?
               AND total_funneled >= ?
        `).all(`-${t.sybilFunnelWindowDays}`, t.sybilFunnelMinInvitees, t.sybilFunnelMinAmount) as any[];

        // Secondary: direct transfers (for Resident+ accounts that graduated past Ghost)
        const directFunnelRows = db.prepare(`
            SELECT 
                inviter.public_key as farmer_pubkey,
                inviter.callsign as farmer_callsign,
                COUNT(DISTINCT txn.from_pubkey) as puppet_count,
                ROUND(SUM(txn.amount), 2) as total_funneled,
                GROUP_CONCAT(DISTINCT puppet.callsign) as puppet_names,
                GROUP_CONCAT(DISTINCT puppet.public_key) as puppet_keys
            FROM transactions txn
            JOIN members puppet ON txn.from_pubkey = puppet.public_key
            JOIN members inviter ON puppet.invited_by = inviter.public_key
            WHERE txn.to_pubkey = inviter.public_key
              AND txn.from_pubkey NOT LIKE 'escrow_%'
              AND txn.to_pubkey NOT LIKE 'escrow_%'
              AND txn.from_pubkey NOT LIKE 'project_%'
              AND txn.to_pubkey != 'commons'
              AND txn.from_pubkey != 'SYSTEM'
              AND txn.timestamp > datetime('now', ? || ' days')
            GROUP BY inviter.public_key
            HAVING puppet_count >= ?
               AND total_funneled >= ?
        `).all(`-${t.sybilFunnelWindowDays}`, t.sybilFunnelMinInvitees, t.sybilFunnelMinAmount) as any[];

        // Merge & deduplicate by farmer
        const seen = new Set<string>();
        for (const row of [...funnelRows, ...directFunnelRows]) {
            if (seen.has(row.farmer_pubkey)) continue;
            seen.add(row.farmer_pubkey);

            // Isolation check: do the puppets trade with ANYONE else?
            const puppetPubkeys = db.prepare(`
                SELECT public_key FROM members WHERE invited_by = ?
            `).all(row.farmer_pubkey) as any[];
            
            let isolatedPuppets = 0;
            for (const p of puppetPubkeys) {
                const marketPartners = db.prepare(`
                    SELECT COUNT(DISTINCT partner) as cnt FROM (
                        SELECT seller_pubkey as partner FROM marketplace_transactions
                        WHERE buyer_pubkey = ? AND seller_pubkey != ? AND status = 'completed'
                        UNION
                        SELECT buyer_pubkey as partner FROM marketplace_transactions
                        WHERE seller_pubkey = ? AND buyer_pubkey != ? AND status = 'completed'
                    )
                `).get(p.public_key, row.farmer_pubkey, p.public_key, row.farmer_pubkey) as any;

                const directPartners = db.prepare(`
                    SELECT COUNT(DISTINCT partner) as cnt FROM (
                        SELECT to_pubkey as partner FROM transactions
                        WHERE from_pubkey = ? AND to_pubkey != ?
                          AND to_pubkey NOT LIKE 'escrow_%' AND to_pubkey NOT LIKE 'project_%'
                          AND to_pubkey != 'commons' AND to_pubkey != 'SYSTEM'
                        UNION
                        SELECT from_pubkey as partner FROM transactions
                        WHERE to_pubkey = ? AND from_pubkey != ?
                          AND from_pubkey NOT LIKE 'escrow_%' AND from_pubkey NOT LIKE 'project_%'
                          AND from_pubkey != 'commons' AND from_pubkey != 'SYSTEM'
                    )
                `).get(p.public_key, row.farmer_pubkey, p.public_key, row.farmer_pubkey) as any;

                if ((marketPartners?.cnt || 0) + (directPartners?.cnt || 0) === 0) isolatedPuppets++;
            }

            flags.push({
                type: 'sybil_funnel',
                severity: 'alert',
                description: `Invite funnel: ${row.puppet_count} invitees of "${row.farmer_callsign}" sent ${row.total_funneled}B back (${isolatedPuppets} with 0 other partners)`,
                members: [row.farmer_pubkey, ...(row.puppet_keys?.split(',') || [])]
            });
        }
    } catch (e) { console.error('Health flag check (sybil funnel) failed:', e); }

    // 4. Aggregate Credit Spike (Do Day-over-Day Growth check)
    //
    // Every read below orders by `timestamp DESC, id DESC`, never timestamp alone. system_metrics
    // timestamps are millisecond-precision strftime defaults, so two writes in the same millisecond
    // tie — and SQLite then returns an ARBITRARY one of them for `LIMIT 1`. "The latest metric"
    // silently becomes "one of the latest metrics", which is how an alert fails to fire on exactly
    // the busy node that most needs it. The table has an AUTOINCREMENT id; insertion order is the
    // tiebreak. (Found via a 15%-flaky test-backend-monitors: audit.ts records the same metric key,
    // and when its write landed in the same millisecond as the test's the spike went undetected.)
    try {
        const currentMetricRow = db.prepare(`
            SELECT metric_value FROM system_metrics 
            WHERE metric_key = 'total_negative_balance' 
            ORDER BY timestamp DESC, id DESC LIMIT 1
        `).get() as any;

        const previousMetricRow = db.prepare(`
            SELECT metric_value FROM system_metrics 
            WHERE metric_key = 'total_negative_balance' 
              AND datetime(timestamp) < datetime('now', '-23 hours')
            ORDER BY timestamp DESC, id DESC LIMIT 1
        `).get() as any;

        if (currentMetricRow && previousMetricRow) {
            const current = currentMetricRow.metric_value;
            const previous = previousMetricRow.metric_value;
            if (previous > 0) {
                const growthRatio = (current - previous) / previous;
                const absoluteGrowth = current - previous;
                if (growthRatio > 0.20 && absoluteGrowth >= 500) {
                    flags.push({
                        type: 'aggregate_spike',
                        severity: 'alert',
                        description: `Aggregate credit spike: total negative balance increased by ${(growthRatio * 100).toFixed(1)}% (+${absoluteGrowth.toFixed(1)}B) in 24h`,
                        members: []
                    });
                }
            }
        }
    } catch (e) { console.error('Health flag check (aggregate credit spike) failed:', e); }

    // 5. Cohort Velocity Anomaly
    try {
        const cohortAnomalyRow = db.prepare(`
            SELECT metric_value FROM system_metrics 
            WHERE metric_key = 'cohort_anomalies' 
            ORDER BY timestamp DESC, id DESC LIMIT 1
        `).get() as any;
        if (cohortAnomalyRow && cohortAnomalyRow.metric_value > 0) {
            flags.push({
                type: 'cohort_velocity',
                severity: 'warning',
                description: `Cohort Velocity Anomaly: ${cohortAnomalyRow.metric_value} cohort(s) reached deep floors within 14 days of creation`,
                members: []
            });
        }
    } catch (e) { console.error('Health flag check (cohort velocity) failed:', e); }

    // 6. Delinquency (Realized Loss Risk)
    try {
        const delinquentRow = db.prepare(`
            SELECT metric_value FROM system_metrics 
            WHERE metric_key = 'delinquent_accounts' 
            ORDER BY timestamp DESC, id DESC LIMIT 1
        `).get() as any;
        if (delinquentRow && delinquentRow.metric_value > 0) {
            flags.push({
                type: 'delinquency',
                severity: 'warning',
                description: `Realized loss risk: ${delinquentRow.metric_value} credit-drawn account(s) are dormant for 7+ days`,
                members: []
            });
        }
    } catch (e) { console.error('Health flag check (delinquency) failed:', e); }

    // 7. Watchdog: surface auto-recoveries from event-loop freezes (see the
    // 2026-07-18 incident) and a watchdog that has gone silent. The fleet
    // manager turns these flags into alerts automatically.
    const watchdog = readWatchdogStatus();
    try {
        if (watchdog.recoveries > 0) {
            flags.push({
                type: 'watchdog_recovery',
                severity: 'critical',
                description: `Node auto-recovered from ${watchdog.recoveries} event-loop freeze${watchdog.recoveries > 1 ? 's' : ''}${watchdog.lastRecoveryAt ? ` (last: ${watchdog.lastRecoveryAt})` : ''} — a hang recurred and the host watchdog restarted the node`,
                members: []
            });
        }
        if (watchdog.present && !watchdog.healthy) {
            flags.push({
                type: 'watchdog_down',
                severity: 'alert',
                description: `Host watchdog heartbeat is stale${watchdog.lastSeenAt ? ` (last seen ${watchdog.lastSeenAt})` : ''} — this node is currently running without freeze auto-recovery`,
                members: []
            });
        }
    } catch (e) { console.error('Health flag check (watchdog) failed:', e); }

    // 8. Stray rejected promises the process-level net caught. Each one used to end the process and drop
    // every connected member for about a minute; now the node keeps serving and this says so instead. The
    // count resets on restart, so a figure here means it happened during THIS run. The error text is
    // deliberately not repeated: `flags` carries member public keys and fraud findings and is admin-only,
    // but the detail belongs on the diagnostics screen, next to the log file that holds the stack.
    try {
        const rejections = getUnhandledRejectionSummary();
        if (rejections.count > 0) {
            flags.push({
                type: 'unhandled_rejections',
                severity: 'warning',
                description: `${rejections.count} background task${rejections.count > 1 ? 's' : ''} failed without being handled since this node last started${rejections.lastAt ? ` (last: ${rejections.lastAt})` : ''} — the node kept serving; see Diagnostics and data/unhandled-rejections.log`,
                members: []
            });
        }
    } catch (e) { console.error('Health flag check (unhandled rejections) failed:', e); }

    const config = getLocalConfig();
    const reportCount = getReportCount();
    
    return {
        nodeName: getDirectoryInfo()?.name || 'Local Discovery',
        version: getVersion(),
        // The app reads both of these. `minAppVersion` is this node's floor — below it
        // the app says so and will not let you dismiss it. `appVersions` is what the
        // stores are publishing, looked up here so 1.1 MB of Play Store HTML is not
        // downloaded onto a phone on a metered off-grid connection to learn one number.
        minAppVersion: getMinAppVersion(),
        appVersions: getAppStoreVersions(),
        currency: { type: config.currencyType || 'image', value: config.currencyValue || 'bean' },
        tree: { totalMembers, maxDepth: 0, widestBranch: { callsign: 'db-optimized', children: 0 }, avgBranchSize: 0 },
        activity: {
            totalTransactions: (db.prepare(`SELECT COUNT(*) as c FROM transactions`).get() as any).c,
            totalPosts: (db.prepare(`SELECT COUNT(*) as c FROM posts WHERE status IN ('active', 'pending')`).get() as any).c,
            last7Days: (db.prepare(`SELECT COUNT(*) as c FROM transactions WHERE timestamp > datetime('now', '-7 days')`).get() as any).c,
            last30Days: (db.prepare(`SELECT COUNT(*) as c FROM transactions WHERE timestamp > datetime('now', '-30 days')`).get() as any).c,
            activeMemberCount,
            inactiveMemberCount,
            commonsBalance: Math.round(COMMONS_BALANCE * 100) / 100
        },
        flags,
        reportCount,
        watchdog
    };
}

// ===================== ADMIN CONTROLS =====================

/**
 * @deprecated Replaced by explicit node_roles. Use getFirstNodeAdminPubkey() or isNodeAdmin().
 */
export function getAdminPubkey(): string {
    const row = db.prepare("SELECT public_key FROM members WHERE invited_by = 'genesis' AND UPPER(public_key) != 'SYSTEM' AND public_key != '' AND status = 'active' ORDER BY rowid ASC LIMIT 1").get() as { public_key: string } | undefined;
    // Empty string, not 'system', when a node has no human admin. Every override site is
    // guarded via isAdminPubkey() so an empty admin key can never match an empty actor.
    return (row?.public_key && typeof row.public_key === 'string') ? row.public_key.trim() : '';
}

/**
 * Check whether a public key belongs to an active genesis administrator or holds a node admin/owner role.
 * Guards against the empty-string sentinel hazard: an empty or missing public key
 * must never match an empty getAdminPubkey() fallback.
 */
export function isAdminPubkey(publicKey: string): boolean {
    if (!publicKey || typeof publicKey !== 'string') return false;
    if (isNodeAdmin(publicKey)) return true;
    const admin = getAdminPubkey();
    return Boolean(admin && publicKey === admin);
}
/**
 * Write the status row only, with no broadcast.
 *
 * Split out because a WebSocket broadcast cannot be rolled back (review finding). `adminPruneUser` runs
 * inside a transaction that can still fail after this point, and a `profile_updated` sent from inside it
 * would tell every connected client the member was pruned while the database reverted — the clients would
 * be showing a state the node does not have, until something refreshed them.
 *
 * The row write and the announcement are therefore separate, and the prune announces after it commits.
 */
export function setUserStatusRow(publicKey: string, status: 'active' | 'disabled' | 'pruned') {
    db.prepare("UPDATE members SET status=? WHERE public_key=?").run(status, publicKey);
    if (status !== 'active') {
        try { db.prepare("DELETE FROM node_roles WHERE member_pubkey = ?").run(publicKey); } catch { }
    }
    // Either way the owner set may have changed: an owner disabled or pruned, or one made active again.
    noteTakeoverInputsChanged(`member ${status === 'active' ? 'reactivated' : status}`);
    clearEnterpriseFloorCache();
}

export function adminSetUserStatus(publicKey: string, status: 'active' | 'disabled' | 'pruned') {
    setUserStatusRow(publicKey, status);
    broadcast({ type: 'profile_updated', publicKey });
}

export function adminSetCreditFrozen(publicKey: string, frozen: boolean) {
    db.prepare("UPDATE members SET credit_frozen=? WHERE public_key=?").run(frozen ? 1 : 0, publicKey);
    clearEnterpriseFloorCache(publicKey);
    clearEnterpriseFloorCache();
    broadcast({ type: 'profile_updated', publicKey });
}

/**
 * Admin: promote a member to (or demote from) the Elder tier so they can help verify
 * (vouch for) other members. Pulls the SAME lever as a genesis "Elder invite" — it sets
 * the member's pre-seeded earned_credit, which lowers their credit floor into the Elder
 * band; tier follows from floor as usual (one source of truth, no separate role). Grants
 * the Elder vouch/verify capability + Elder borrowing/gifting standing, but NOT
 * password-admin powers (prune, delete, announcements), which stay behind the admin
 * password.
 *
 * Balance-safe: earned_credit is a borrowing *limit*, not a ledger balance. This makes no
 * transaction and mints/moves no beans — the member keeps their exact balance (positive
 * OR negative) and the double-entry books stay balanced. Granting only widens their credit
 * limit; revoking (back to 0) narrows it, leaving any balance untouched. Idempotent.
 */
/**
 * Assign a tier BADGE to a member (admin-only). The badge grants that tier's trust value into
 * the granted-credit lane, so the member's floor lands at the tier's entry (Resident -200,
 * Steward -600, Elder -1400; Newcomer clears the grant). Balance-safe — grants a credit *limit*,
 * mints/moves no beans. This is a floor grant only; the separate can_vouch capability
 * (adminSetVoucher) is what confers the power to vouch. Idempotent.
 */
export function adminSetTier(publicKey: string, tier: TierName): { ok: true } {
    if (!getMember(publicKey)) throw new Error('Member not found');
    const granted = grantedCreditForTier(tier);
    db.prepare("UPDATE members SET earned_credit=? WHERE public_key=?").run(granted, publicKey);
    broadcast({ type: 'profile_updated', publicKey });
    return { ok: true };
}

// Back-compat wrapper: Elder is simply the top tier badge.
export function adminSetElder(publicKey: string, granted: boolean): { ok: true } {
    return adminSetTier(publicKey, granted ? 'Elder' : 'Newcomer');
}

/**
 * Grant or revoke the vouch capability (the "appointed voucher" / super-Elder switch).
 * Admin-only — this is the single Sybil-critical power (handing out the -20 floor), so it is
 * never derived from tier; an admin appoints trusted members (typically Elders) explicitly.
 * Toggling can_vouch mints no beans and changes no floors of its own. Idempotent.
 */
export function adminSetVoucher(publicKey: string, granted: boolean): { ok: true } {
    if (!getMember(publicKey)) throw new Error('Member not found');
    db.prepare("UPDATE members SET can_vouch=? WHERE public_key=?").run(granted ? 1 : 0, publicKey);
    broadcast({ type: 'profile_updated', publicKey });
    return { ok: true };
}

/**
 * Grant or revoke the treasury operator capability. Admin-only; mirrors adminSetVoucher.
 * Toggling can_operate mints no beans and changes no floors. Idempotent.
 */
export function adminSetOperator(publicKey: string, granted: boolean): { ok: true } {
    // Switched on only for a member: a visitor's row keeps nothing, as a key with no row keeps nothing (getActingMember).
    // Switching it off is always allowed.
    if (!(granted ? getActingMember(publicKey) : getMember(publicKey))) throw new Error('Member not found');
    db.prepare("UPDATE members SET can_operate=? WHERE public_key=?").run(granted ? 1 : 0, publicKey);
    broadcast({ type: 'profile_updated', publicKey });
    return { ok: true };
}

/**
 * Create a community treasury — a real member account that is the Commons' trading face for an
 * enterprise: it authors the enterprise's offers/needs and settles escrow, but (unlike a person)
 * is exempt from demurrage (its held balance doesn't erode), granted a bounded credit line so it
 * can run the enterprise at a deficit (repaid by income — and only while it keeps ≥1 live Offer,
 * the "offer covenant"), and flagged is_treasury=1 so it stays out of the member directory.
 * Balance-safe: mints no beans (creditLine is a borrowing *limit*, capped at CREDIT_FLOOR_CAP). A
 * keypair is generated so an operator can load the treasury identity onto a device later; day to
 * day it is driven server-side through operator-authenticated routes.
 */
export function createTreasury(
    name: string,
    avatar: string,
    creditLine = 0,
    // #143 step 3: a federation link is created AUTOMATICALLY when a peer gains a credit cap, so there is
    // no operator present to choose a picture. The Commons card already falls back to a glyph on a blank
    // avatar, so an avatarless enterprise renders fine. Opt-in rather than dropping the guard, which stays
    // as it was for every operator-created treasury.
    // opts.workingCapitalCeiling sets Rule 7 ceiling (docs/the-commons.md §2.4).
    // Unified enterprise fields (docs/the-commons.md §2.1, Slice 3): purpose, lifecycle, goalAmount, deadlineAt, paused.
    opts: {
        systemCreated?: boolean;
        workingCapitalCeiling?: number | null;
        purpose?: string;
        lifecycle?: 'ongoing' | 'bounded';
        goalAmount?: number | null;
        deadlineAt?: string | null;
        paused?: boolean;
        publicKeyHex?: string;
        leadKeeperPubkey?: string;
        lat?: number | null;
        lng?: number | null;
        locationAuthSigner?: string;
    } = {},
): { publicKey: string } {
    const trimmed = (name || '').trim();
    if (trimmed.length < 2) throw new Error('Treasury name must be at least 2 characters');
    if (!avatar && !opts.systemCreated) throw new Error('Treasury needs an avatar image');
    // Bare base64 is judged by the photo rule in both routes that pass a sender's value (POST /api/treasury and
    // /api/enterprise, POST /api/local/admin/treasury); the other callers pass a bundled:// name or nothing.
    if (!isAcceptableAvatarValue(avatar)) throw new Error(AVATAR_FORMAT_ERROR);
    // Served by /api/avatar/<enterprise key> to anyone who asks, so it is stored without its metadata (G9a-3).
    avatar = stripImageValue(avatar);
    // Same predicate as idx_members_callsign_unique (`status NOT IN ('migrated', 'pruned')`),
    // so this pre-check agrees with the index that will actually enforce it on INSERT. Under
    // the old `status!='migrated'` a pruned member's callsign still read as taken here, while
    // the index happily allowed it — a treasury name refused for a member the node has let go.
    if (db.prepare("SELECT 1 FROM members WHERE lower(callsign)=lower(?) AND status NOT IN ('migrated', 'pruned')").get(trimmed)) {
        throw new Error('That name is already taken');
    }
    if (opts.leadKeeperPubkey && isOperatorSwitchedOff(opts.leadKeeperPubkey)) {
        throw new Error(OPERATOR_SWITCHED_OFF_CREATE_ERROR);
    }
    const line = Math.max(0, Math.min(PROTOCOL_CONSTANTS.CREDIT_FLOOR_CAP, Math.round(creditLine)));
    let ceiling: number | null = null;
    if (opts.workingCapitalCeiling !== undefined && opts.workingCapitalCeiling !== null) {
        const num = Number(opts.workingCapitalCeiling);
        if (!Number.isFinite(num) || num < 0) {
            throw new Error('Working capital ceiling must be a non-negative finite number or null');
        }
        ceiling = num;
    }

    const purpose = opts.purpose || '';
    const lifecycle = opts.lifecycle || 'ongoing';
    const goalAmount = opts.goalAmount != null ? Number(opts.goalAmount) : null;
    const deadlineAt = opts.deadlineAt || null;
    const paused = opts.paused ? 1 : 0;

    let latVal: number | null = null;
    let lngVal: number | null = null;
    if (opts.lat != null || opts.lng != null) {
        if (opts.lat == null || opts.lng == null) {
            throw new Error('Both latitude and longitude must be provided');
        }
        const lat = Number(opts.lat);
        const lng = Number(opts.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            throw new Error('Latitude and longitude must be valid numbers');
        }
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            throw new Error('Latitude must be between -90 and 90, longitude between -180 and 180');
        }
        latVal = lat;
        lngVal = lng;
    }

    let pubKeyHex = opts.publicKeyHex;
    if (!pubKeyHex) {
        const { publicKey } = crypto.generateKeyPairSync('ed25519', {
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        pubKeyHex = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    }

    db.transaction(() => {
        // invited_by/invite_code left NULL: a treasury is system-created, it has no inviter
        // (and invited_by is an FK to members — 'genesis' is not itself a member row).
        // Enterprise credit model: earned_surplus = 0, working_capital_ceiling = ceiling (docs/the-commons.md §2.4 Rules 6 & 7)
        // Grandfather legacy floor: preserved if line > 0, otherwise derived from keepers' pledges.
        const signerVal = opts.locationAuthSigner || opts.leadKeeperPubkey || null;
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, is_treasury, earned_credit, earned_surplus, working_capital_ceiling, legacy_credit_floor, purpose, goal_amount, deadline_at, lifecycle, paused, lat, lng, location_auth_signer, auth_signer, location_updated_at)
                    VALUES (?, ?, ?, ?, 'active', 1, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(pubKeyHex, trimmed, now, avatar, line, ceiling, line > 0 ? line : null, purpose, goalAmount, deadlineAt, lifecycle, paused, latVal, lngVal, latVal != null ? signerVal : null, latVal != null ? signerVal : null, latVal != null ? now : null);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
        if (opts.leadKeeperPubkey) {
            db.prepare(`INSERT OR IGNORE INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_at, granted_by)
                        VALUES (?, ?, 'lead', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'creator')`).run(pubKeyHex, opts.leadKeeperPubkey);
            raiseCreatorOperatorSwitch(opts.leadKeeperPubkey, pubKeyHex);
        }
        db.prepare(`INSERT OR IGNORE INTO conversations (id, type, name, created_by, created_at)
                    VALUES (?, 'enterprise_thread', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
            .run(pubKeyHex, trimmed, opts.leadKeeperPubkey || pubKeyHex);
    })();

    clearEnterpriseFloorCache(pubKeyHex);
    ledger.initializeGenesisAccount(pubKeyHex);
    ledger.setDecayExempt(pubKeyHex);
    // The card, never the whole row: every member socket gets this (engine/members.ts registerMemberInternal).
    broadcast({ type: 'member_joined', member: publicMemberCard(getMember(pubKeyHex)!) });
    broadcast({ type: 'treasury_created', publicKey: pubKeyHex, name: trimmed });
    console.log(`🏛️ Treasury created: "${trimmed}" (${pubKeyHex.substring(0, 12)}…) creditLine=${line}`);
    return { publicKey: pubKeyHex };
}

/** The post as it stood before an admin removal: who wrote it and whether it was still live. */
type PostBeforeTakedown = { id: string; title: string | null; authorPubkey: string | null; wasLive: boolean; createdAt: string | null };
function postBeforeTakedown(postId: string): PostBeforeTakedown | null {
    const row = db.prepare('SELECT id, title, author_pubkey, active, status, created_at FROM posts WHERE id = ?').get(postId) as any;
    if (!row) return null;
    return { id: row.id, title: row.title ?? null, authorPubkey: row.author_pubkey ?? null, wasLive: row.active === 1 && row.status !== 'cancelled', createdAt: row.created_at ?? null };
}

/**
 * Remove the post, without telling anyone yet. Returns what the notices need, or null when nothing was removed.
 *
 * `onRefundShortfall` is how a removal reports that a pending trade's escrow held less than the trade row
 * said, so its buyer could not be made whole. The engine refunds what the escrow actually holds and calls
 * this; it never tops the difference up out of nothing.
 *
 * `takedown`: a moderator removed this one post, as opposed to the stale-post prune. A takedown of a live post is
 * recorded on it (`removed_by_moderator_at`), which is what auto-mute counts and what makes it not a kept post.
 */
function removePostByAdmin(postId: string, onRefundShortfall?: (s: EscrowRefundShortfall) => void, takedown = false): PostBeforeTakedown | null {
    const before = postBeforeTakedown(postId);
    // The push dispatcher is passed so an admin removing a reported EVENT tells everyone marked Going
    // that it is off (docs/events-on-the-map.md §2.5); it is a no-op for every other post type.
    const ok = adminDeletePostEngine(broadcast, postId, transfer, conservingTransaction, dispatchPushNotification, {
        // Straight off the in-memory ledger, which is what `transfer()` checks its floor against — a
        // refund capped by any other reading of the balance could still be refused, or still overdraw.
        balanceOf: (escrowAccount: string) => ledger.getAccount(escrowAccount).balance,
        onRefundShortfall,
    });
    if (ok && before && takedown && before.wasLive) recordModeratorRemoval(postId);
    return ok && before ? before : null;
}

/**
 * An admin removes a post. Its author is told, in words and without naming the admin; every still-open
 * report on it is closed and its reporter told the post was removed. `reasonCategory` is one of
 * REMOVAL_REASON_LABELS' keys, or ignored.
 */
export function adminDeletePost(
    postId: string,
    opts?: { reasonCategory?: string | null; onRefundShortfall?: (s: EscrowRefundShortfall) => void },
): boolean {
    const removed = removePostByAdmin(postId, opts?.onRefundShortfall, true);
    if (!removed) return false;
    const reporters = closeOpenReportsOnPost(postId);
    notifyPostTakedown(moderationNoticeCb, removed, reporters, normaliseRemovalReason(opts?.reasonCategory));
    // The third removal in 30 days mutes its author on the global profile (G3).
    if (removed.wasLive) evaluateAutoMute(moderationNoticeCb, removed.authorPubkey);
    return true;
}

const moderationNoticeCb = {
    broadcast: (event: any, recipients?: string[], opts?: BroadcastOptions) => broadcast(event, recipients, opts),
    dispatchPushNotification: (...args: Parameters<typeof dispatchPushNotification>) => dispatchPushNotification(...args),
};

export function isSoleOwner(publicKey: string): boolean {
    if (!isNodeOwner(publicKey)) return false;
    // Other owners whose role acts (NODE_ROLE_ACTS): a visitor's row's owner role can't keep the node.
    const ownerCount = (db.prepare(
        `SELECT COUNT(*) as c FROM node_roles nr
         JOIN members m ON nr.member_pubkey = m.public_key
         WHERE nr.role = 'owner' AND ${NODE_ROLE_ACTS} AND nr.member_pubkey != ?`
    ).get(publicKey) as any)?.c || 0;
    return ownerCount === 0;
}

/**
 * The actor a community Decision acts as when it prunes (grace expiry, an admin speeding up a passed removal).
 * The community's vote is what authorises it, so it counts as owner level for the prune gate below.
 */
export const COMMUNITY_DECISION_ACTOR = 'system:community-decision';

/** Owner level: an owner's key, or the password (only owners hold it). */
export function isOwnerLevelActor(actor: string | null | undefined): boolean {
    if (!actor) return false;
    return actor === 'owner:password' || isNodeOwner(actor);
}

/**
 * The owner or admin role a member holds, counting one held aside while they are suspended — a suspended
 * co-owner is still an owner for the purpose of who may prune them.
 */
export function heldPrivilegedRole(publicKey: string): 'owner' | 'admin' | null {
    const rows = db.prepare(`
        SELECT role FROM node_roles WHERE member_pubkey = ? AND role IN ('owner', 'admin')
        UNION ALL
        SELECT role FROM suspended_node_roles WHERE member_pubkey = ? AND role IN ('owner', 'admin')
    `).all(publicKey, publicKey) as { role: 'owner' | 'admin' }[];
    if (rows.some(r => r.role === 'owner')) return 'owner';
    return rows.length ? 'admin' : null;
}

/**
 * node_roles: only an owner may grant (so only an owner may take away) an owner or admin role, and pruning
 * takes it away for good. A plain admin gets a 403. Leaving yourself and a community Decision are allowed.
 */
export function assertMayPrune(publicKey: string, actor: string): void {
    const role = heldPrivilegedRole(publicKey);
    if (!role || actor === publicKey || actor === COMMUNITY_DECISION_ACTOR || isOwnerLevelActor(actor)) return;
    const err: any = new Error(`Only an owner can remove ${role === 'owner' ? 'an owner' : 'an admin'}. Propose a Decision to remove them instead`);
    err.status = 403;
    throw err;
}

/**
 * The posts a closed account (adminPruneUser, purgeMemberSelf) leaves behind, as SQL lists. A post's status is one of
 * active, pending (a deal in escrow), paused, completed and cancelled. The last two are where a post ends; each of the
 * first three can come back up (pending when its deal is cancelled, paused when its author resumes it), so the account's
 * posts in those are cancelled, and its open or paused polls closed with their votes kept. Paused was missed until
 * 4109713263: its author, removed or self-deleted, put it back up and moved it.
 */
const PRUNE_CLOSES_POSTS_IN = "('active', 'pending', 'paused')";
const POLLS_A_PRUNE_CLOSES = "('active', 'paused')";

/**
 * `actor` is the authenticated admin actor (a pubkey or 'owner:password'), the member themselves, or
 * COMMUNITY_DECISION_ACTOR — never one read from a request body.
 */
export function adminPruneUser(publicKey: string, actor: string) {
    if (isSoleOwner(publicKey)) {
        throw new Error('Cannot prune the sole node owner; appoint another owner first');
    }
    assertMayPrune(publicKey, actor);

    // `conservingTransaction`, not a bare `db.transaction` (review finding). Both branches below mutate the
    // in-memory ledger and the COMMONS_BALANCE global as well as the rows, and two statements run AFTER
    // them — `adminSetUserStatus` and the posts cancellation. If either throws, SQLite rolls the rows back
    // and memory would keep the write-off or the confiscation: a permanent split between the two, and the
    // next persistCommonsBalance() would make the wrong figure durable. Reachable, not theoretical —
    // adminPruneBranch drives this recursively over a whole invite subtree.
    conservingTransaction(() => {
        const account = ledger.getAccount(publicKey);
        const balance = account.balance;

        // #124. These used to go through `transfer(..., 'COMMONS_POOL', ...)`, which moves the COMMONS_POOL
        // *account* — only the persisted shadow of the `COMMONS_BALANCE` global, rewritten from that global
        // after every transfer. So the confiscation was discarded and the write-off was funded from nowhere,
        // minting beans. Both directions broke conservation; only the direction differed.
        //
        // `allowDeficit` on the write-off is required by the documented Solvency Rule
        // (docs/commons-pool-transparency.md): "to delete the account and maintain the zero-sum invariant,
        // the community must pay off the debt". So a prune must ALWAYS balance the books, even when the pot
        // is empty — that document names an empty pot as a threat to balance, not a reason to refuse. A
        // negative Commons is the honest record of a community that has written off more than it collected,
        // and the network still sums to zero, which is the invariant that matters.
        // Memos carry the SHORT pubkey: these rows surface in activity feeds and the CSV audit export,
        // where a 64-character hex string wraps and buries the sentence. Nothing is lost — the full key is
        // already the row's `from_pubkey`/`to_pubkey`, which is what any audit actually joins on.
        const who = publicKey.slice(0, 8);
        if (balance < 0) {
            const D = Math.abs(balance);
            payFromCommons(publicKey, D, `Settle bad debt for pruned user: ${who}`, { allowDeficit: true });
        } else if (balance > 0) {
            // THROW on refusal. The prune below marks the member 'pruned' and anonymises the row; if the
            // confiscation quietly returned null the account would keep its balance with nobody able to
            // reach it, and the network would stop summing to zero — the precise invariant the comment
            // above says a prune must always preserve. We are inside a conservingTransaction.
            const confiscated = moveToCommons(publicKey, balance, `Confiscate credit for pruned user: ${who}`,
                { allowMemberDebit: true });
            if (!confiscated) throw new Error(`Could not confiscate the balance of ${who} — prune aborted`);
        }

        // `setUserStatusRow`, not `adminSetUserStatus` — the latter broadcasts, and a broadcast cannot be
        // rolled back. The posts UPDATE below can still fail, so announcing from in here would tell every
        // client the member was pruned while the database reverted.
        setUserStatusRow(publicKey, 'pruned');
        // A person's coarse area (G4) goes too: a pruned account can't sign the request that clears it.
        db.prepare('UPDATE members SET area_lat = NULL, area_lng = NULL, area_updated_at = NULL WHERE public_key = ? AND area_lat IS NOT NULL').run(publicKey);
        // Every post that could come back (PRUNE_CLOSES_POSTS_IN): a paused one too, or its author could put it back up
        // and move it (4109713263). The cancel now stamps updated_at, as the poll close does, so it replicates.
        db.prepare(`UPDATE posts SET status='completed', active=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE author_pubkey=? AND type='poll' AND status IN ${POLLS_A_PRUNE_CLOSES}`).run(publicKey);
        db.prepare(`UPDATE posts SET status='cancelled', active=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE author_pubkey=? AND status IN ${PRUNE_CLOSES_POSTS_IN}`).run(publicKey);
        // Same scrub as purgeMemberSelf, and it has to happen here rather than being left to the
        // member: a pruned account can no longer sign a request, deleteChannel is owner-scoped, and
        // there is no admin route for it — so anything left behind stays on every mirror and backup
        // permanently, with nobody able to remove it.
        const prunedAt = new Date().toISOString();
        scrubChannelRows({ ownerPubkey: publicKey }, prunedAt);
        scrubPulseItems({ ownerPubkey: publicKey }, prunedAt);
        try { db.prepare("DELETE FROM node_roles WHERE member_pubkey = ?").run(publicKey); } catch { }
        db.prepare("DELETE FROM suspended_node_roles WHERE member_pubkey = ?").run(publicKey);
        try { db.prepare("DELETE FROM push_tokens WHERE public_key = ?").run(publicKey); } catch { }
        // A pruned account can't sign the request that removes a place watch (G5), and must hear nothing from one.
        dropPlaceWatches(publicKey);
        // What they wrote when they asked to join (G6) goes with them; the record of the knock stays.
        scrubKnocksOf(publicKey);
        // The moderation notices kept for them: nobody can read them now (engine/kept-notices.ts).
        dropKeptNoticesOf(publicKey);
    });
    // Both announcements happen only once the transaction has committed.
    broadcast({ type: 'profile_updated', publicKey });
    broadcast({ type: 'user_pruned', publicKey });
}

/**
 * Self-service member purge (#99): allows a member to permanently purge their identity
 * and account from this node, provided they have zero active or pending escrow deals.
 *
 * Atomically:
 * 1. Validates no active escrows as buyer or seller.
 * 2. Settles positive or negative balance with COMMONS_POOL.
 * 3. Anonymizes member profile (callsign -> 'Deleted Member', removes avatar, bio, archetype, contact, coarse area).
 * 4. Closes its open and paused polls, and cancels every other post that could come back (active, pending, paused).
 * 5. Purges push tokens, guardian shares, friend links, preferences, and recovery state.
 * 6. Writes tombstones for delta-sync replication.
 */
export function purgeMemberSelf(publicKey: string): { ok: boolean; message: string } {
    // A visitor's row has no account here to delete, as a key with no row has none (getActingMember): a member who
    // wrote to it or paid it keeps that conversation and those Beans.
    const member = getActingMember(publicKey);
    if (!member) {
        throw new Error('Member not found');
    }
    if (member.status === 'pruned') {
        return { ok: true, message: 'Account is already pruned' };
    }

    if (isNodeOwner(publicKey)) {
        const ownerCount = (db.prepare(
            `SELECT COUNT(*) as c FROM node_roles nr
             JOIN members m ON nr.member_pubkey = m.public_key
             WHERE nr.role = 'owner' AND ${NODE_ROLE_ACTS} AND nr.member_pubkey != ?`
        ).get(publicKey) as any)?.c || 0;
        if (ownerCount === 0) {
            throw new Error('Cannot purge the sole node owner; appoint another owner first');
        }
    }

    // Atomically check escrows, settle balance, anonymize profile, cancel listings, and purge personal records
    conservingTransaction(() => {
        // 1. Guard against active or pending escrows (as buyer or seller)
        const activeEscrows = db.prepare(`
            SELECT COUNT(*) as c FROM marketplace_transactions 
            WHERE (buyer_pubkey = ? OR seller_pubkey = ?) 
              AND status IN ('requested', 'pending')
        `).get(publicKey, publicKey) as any;

        if (activeEscrows && activeEscrows.c > 0) {
            throw new Error('Cannot delete account while you have active deals in escrow. Please complete or cancel pending trades first.');
        }

        // 2. Guard against in-flight cross-node settlements
        const activeSettlements = db.prepare(`
            SELECT COUNT(*) as c FROM settlements
            WHERE (buyer_pubkey = ? OR seller_pubkey = ?)
              AND state IN ('escrowed', 'reserved', 'committed', 'held')
        `).get(publicKey, publicKey) as any;

        if (activeSettlements && activeSettlements.c > 0) {
            throw new Error('Cannot delete account while you have cross-node settlements in flight. Please wait for pending settlements to finalize.');
        }

        // 3. Settle balance with Commons Pool
        const account = ledger.getAccount(publicKey);
        const balance = account.balance;
        const who = publicKey.slice(0, 8);

        if (balance < 0) {
            const D = Math.abs(balance);
            payFromCommons(publicKey, D, `Settle bad debt for self-purged user: ${who}`, { allowDeficit: true });
        } else if (balance > 0) {
            // Same as adminPruneUser: an ignored refusal strands the balance on an anonymised account.
            const returned = moveToCommons(publicKey, balance, `Return balance to Commons for self-purged user: ${who}`, { allowMemberDebit: true });
            if (!returned) throw new Error('Could not return your balance to the Commons — account deletion aborted');
        }

        const now = new Date().toISOString();

        // 4. Anonymize member record and reset privileges
        db.prepare(`
            UPDATE members 
            SET status = 'pruned',
                callsign = 'Deleted Member',
                avatar_url = NULL,
                bio = NULL,
                contact_value = NULL,
                contact_visibility = NULL,
                archetype = NULL,
                can_vouch = 0,
                vouch_credit = 0,
                can_operate = 0,
                credit_frozen = 0,
                elder_vouched_by = NULL,
                area_lat = NULL,
                area_lng = NULL,
                area_updated_at = NULL,
                profile_updated_at = ?,
                updated_at = ?
            WHERE public_key = ?
        `).run(now, now, publicKey);

        // 5. Close open polls immediately, retaining votes; cancel every other post that could come back (as adminPruneUser)
        db.prepare(`
            UPDATE posts 
            SET status = 'completed', 
                active = 0, 
                updated_at = ? 
            WHERE author_pubkey = ? AND type = 'poll' AND status IN ${POLLS_A_PRUNE_CLOSES}
        `).run(now, publicKey);
        db.prepare(`
            UPDATE posts 
            SET status = 'cancelled', 
                active = 0, 
                updated_at = ? 
            WHERE author_pubkey = ? AND status IN ${PRUNE_CLOSES_POSTS_IN}
        `).run(now, publicKey);

        // 6. Purge private device tokens, communication links, and recovery metadata
        try { db.prepare("DELETE FROM push_tokens WHERE public_key = ?").run(publicKey); } catch { }
        dropPlaceWatches(publicKey);
        scrubKnocksOf(publicKey);
        dropKeptNoticesOf(publicKey);
        try { db.prepare("DELETE FROM member_preferences WHERE public_key = ?").run(publicKey); } catch { }
        try { db.prepare("DELETE FROM chat_mutes WHERE member_pubkey = ?").run(publicKey); } catch { }
        try { db.prepare("DELETE FROM thread_read_cursors WHERE member_pubkey = ?").run(publicKey); } catch { }
        // Channels are tombstoned rather than deleted, and their links are cleared with them: the
        // row has to survive so the removal replicates to the backup, but a member who has just
        // erased their profile should not leave their Instagram handle behind on a mirror.
        try {
            scrubChannelRows({ ownerPubkey: publicKey }, now);
            scrubPulseItems({ ownerPubkey: publicKey }, now);
        } catch { }
        // Through deleteAllShares, which writes the tombstone that deletes them on a standby too. Not in a try: a copy left
        // behind here would still bring the deleted account back, so a failure fails the deletion instead.
        deleteAllShares(publicKey);
        try {
            db.prepare("DELETE FROM recovery_releases WHERE collection_id IN (SELECT id FROM recovery_collections WHERE owner_pubkey = ?)").run(publicKey);
            db.prepare("DELETE FROM recovery_collections WHERE owner_pubkey = ?").run(publicKey);
        } catch { }
        // A member who deletes their own account frees the sign-in account they joined with through the open door,
        // so it can join again; the join itself stays on record and still counts for its address. Not while
        // suspended or disabled (the signature middleware lets them sign this route), or deleting the account
        // would be a way out of the sanction with the same sign-in; and never on adminPruneUser, so a member the
        // community removed cannot walk straight back in (engine/open-join.ts).
        if (member.status !== 'suspended' && member.status !== 'disabled') releaseOpenJoin(publicKey);
        try {
            const existingFriends = db.prepare("SELECT owner_pubkey, friend_pubkey FROM friends WHERE owner_pubkey = ? OR friend_pubkey = ?").all(publicKey, publicKey) as { owner_pubkey: string; friend_pubkey: string }[];
            for (const f of existingFriends) {
                try { writeTombstone('friends', `${f.owner_pubkey}|${f.friend_pubkey}`); } catch { }
            }
            db.prepare("DELETE FROM friends WHERE owner_pubkey = ? OR friend_pubkey = ?").run(publicKey, publicKey);
        } catch { }
        try { db.prepare("DELETE FROM treasury_operators WHERE member_pubkey = ? OR treasury_pubkey = ?").run(publicKey, publicKey); } catch { }
        try { db.prepare("DELETE FROM node_roles WHERE member_pubkey = ?").run(publicKey); } catch { }
        // The same line `adminPruneUser` carries, and for the same reason. A SUSPENDED member's node
        // role is not in node_roles at all — the suspension parked it in `suspended_node_roles`, to be
        // given back if the community does not keep the suspension — and the request-signing middleware
        // does not check `members.status`, so a suspended member can still sign this route. Without this,
        // a suspended owner who deletes their account leaves an `owner` row naming a member who has been
        // anonymized and can never be reinstated: `nodeHasOwner()` would report an owner forever on a
        // node that genuinely has none, and the admin-key bootstrap it guards would be blocked for good
        // (#1006 review). Removing the member outright removes what was being held for them.
        db.prepare("DELETE FROM suspended_node_roles WHERE member_pubkey = ?").run(publicKey);
    });
    noteTakeoverInputsChanged('member purged their account');

    broadcast({ type: 'profile_updated', publicKey });
    broadcast({ type: 'user_pruned', publicKey });

    return { ok: true, message: 'Account successfully purged from node.' };
}

export function adminPruneBranch(rootPublicKey: string, actor: string) {
    // Walk the whole invite subtree first and check every member, so a branch holding an owner or admin the
    // actor may not remove is refused before anyone in it is pruned (each prune commits on its own).
    const branch: string[] = [];
    const seen = new Set<string>();
    function walk(pubkey: string) {
        if (seen.has(pubkey)) return;
        seen.add(pubkey);
        branch.push(pubkey);
        const children = db.prepare("SELECT public_key FROM members WHERE invited_by=?").all(pubkey) as any[];
        children.forEach(c => walk(c.public_key));
    }
    walk(rootPublicKey);
    for (const pubkey of branch) assertMayPrune(pubkey, actor);
    // The node must keep an active owner. Checked for the branch as a whole, not member by member: two
    // co-owners in one branch are each not the sole owner until the first is pruned.
    // Same terms as isSoleOwner: an active owner in the branch, and none left outside it.
    const inBranch = new Set(branch);
    const activeOwners = (db.prepare(
        `SELECT nr.member_pubkey FROM node_roles nr JOIN members m ON nr.member_pubkey = m.public_key
         WHERE nr.role = 'owner' AND ${NODE_ROLE_ACTS}`
    ).all() as { member_pubkey: string }[]).map(r => r.member_pubkey);
    if (activeOwners.some(pk => inBranch.has(pk)) && !activeOwners.some(pk => !inBranch.has(pk))) {
        throw new Error("This branch holds the node's only owner, so nobody in it was pruned. Appoint another owner outside the branch first");
    }
    for (const pubkey of branch) adminPruneUser(pubkey, actor);
}

export function adminBroadcastAnnouncement(title: string, body: string, severity: 'info'|'warning'|'critical') {
    broadcast({ type: 'system_announcement', title, body, severity });

    // Also dispatch as a native push notification to all active members. Not to a visitor's row: the /ws copy never reaches
    // its socket (visitorMayReceive), and its push token gets what is sent to it, its messages and Beans, and no member's news.
    try {
        const activeMembers = db.prepare("SELECT public_key FROM members WHERE status != 'disabled' AND status != 'pruned' AND is_visitor = 0").all() as { public_key: string }[];
        const targetPubkeys = activeMembers.map(m => m.public_key);
        dispatchPushNotification(targetPubkeys, 'SYSTEM', title, body, { type: 'system_announcement' }, 'marketplace');
    } catch (e: any) {
        console.error('[Push Announcement] Failed to send push notification broadcast:', e.message);
    }
}

export function adminSendMessage(targetPubkey: string, body: string, senderPubkey?: string) {
    let adminPubkey = senderPubkey || getFirstNodeAdminPubkey() || getAdminPubkey();
    if (!adminPubkey) throw new Error('No genesis admin configured');
    if (adminPubkey.toLowerCase() === 'system') adminPubkey = 'system';
    const conv = createConversation('dm', [adminPubkey, targetPubkey], adminPubkey);
    if (conv) sendMessage(conv.id, adminPubkey, Buffer.from(body, 'utf-8').toString('base64'), 'plaintext-v1');
}

export function migrateAdminConversations() {} // Deprecated, state is clean now.

// ===================== ACTIVITY =====================

export { recordActivity };

// getCommunityHealth, HealthFlag, and CommunityHealth defined above near reports section

// ===================== NODE CONFIG =====================

export function getNodeConfig(): NodeConfig {
    const row = db.prepare("SELECT value FROM node_config WHERE key='node_config'").get() as any;
    // Reliability fix: gracefully handle JSON parse errors on corrupted DB config values
    let config: any = {};
    if (row && row.value) {
        try {
            config = JSON.parse(row.value);
        } catch {
            config = {};
        }
    }

    let migrated = false;
    if ('publishToDirectory' in config || 'password' in config) {
        migrated = true;
        const pub = config.publishToDirectory !== false;
        config.publishLocation = pub;
        config.publishMembers = pub;
        config.publishContacts = pub;
        config.publishHealth = pub;
        delete config.publishToDirectory;
        delete config.password;
    }

    const finalConfig: NodeConfig = {
        serviceRadius: config.serviceRadius,
        publishLocation: config.publishLocation !== false,
        publishMembers: config.publishMembers !== false,
        publishContacts: config.publishContacts !== false,
        publishHealth: config.publishHealth !== false,
        directoryPushIntervalHours: typeof config.directoryPushIntervalHours === 'number' ? config.directoryPushIntervalHours : 12,
        lastDirectoryPush: config.lastDirectoryPush,
        publicAddress: config.publicAddress ?? null,
        ...(Array.isArray(config.ownerAddresses) ? { ownerAddresses: config.ownerAddresses.filter((a: unknown) => typeof a === 'string') } : {}),
    };

    if (migrated) {
        db.prepare(`INSERT INTO node_config (key, value) VALUES ('node_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(finalConfig));
    }

    return finalConfig;
}

export function updateNodeConfig(update: Partial<NodeConfig>): NodeConfig {
    const current = getNodeConfig();
    const next = { ...current, ...update };
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('node_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(next));
    // The public address (with its tunnel token) is in the take-over envelope.
    if ('publicAddress' in update) noteTakeoverInputsChanged('public address changed');
    if ('ownerAddresses' in update) noteTakeoverInputsChanged('confirmed app addresses changed');
    return next;
}

export function resolvePublicNodeUrl(config: NodeConfig = getNodeConfig()): string | null {
    let host: string | null = null;
    const pa: any = config.publicAddress;
    if (pa) {
        if (typeof pa === 'string' && pa.trim()) {
            host = pa.trim();
        } else if (typeof pa === 'object') {
            if (typeof pa.hostname === 'string' && pa.hostname.trim()) {
                host = pa.hostname.trim();
            } else if (typeof pa.name === 'string' && pa.name.trim()) {
                const n = pa.name.trim();
                host = n.includes('.') ? n : `${n}.beanpool.org`;
            }
        }
    }
    if (!host && process.env.CF_RECORD_NAME && process.env.CF_RECORD_NAME.trim()) {
        const cf = process.env.CF_RECORD_NAME.trim();
        host = cf.includes('.') ? cf : `${cf}.beanpool.org`;
    }
    if (!host) return null;
    const clean = host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return clean ? `https://${clean}` : null;
}

export function getDirectoryInfo(): any {
    const config = getNodeConfig();
    if (!config.publishLocation && !config.publishMembers && !config.publishContacts && !config.publishHealth) {
        return null;
    }
    
    const localConfig = getLocalConfig();
    const info: any = {
        name: localConfig.callsign || process.env.BEANPOOL_NODE_NAME || process.env.CF_RECORD_NAME || 'BeanPool Node',
        publicUrl: resolvePublicNodeUrl(config),
    };

    if (config.publishLocation) {
        info.serviceRadius = config.serviceRadius;
    } else {
        info.serviceRadius = null;
    }

    if (config.publishMembers) {
        info.memberCount = (db.prepare("SELECT COUNT(*) as c FROM members WHERE status != 'pruned'").get() as any).c;
    } else {
        info.memberCount = null;
    }

    if (config.publishContacts) {
        if (localConfig.communityName) info.name = localConfig.communityName;
        info.communityName = localConfig.communityName || null;
        if (localConfig.contactEmail) info.contactEmail = localConfig.contactEmail;
        if (localConfig.contactPhone) info.contactPhone = localConfig.contactPhone;
    } else {
        info.communityName = null;
        info.contactEmail = null;
        info.contactPhone = null;
    }

    if (config.publishHealth) {
        const realVersion = getVersion();
        info.version = realVersion;
        info.nodeVersion = realVersion;
        info.status = 'online';
    } else {
        info.version = null;
        info.nodeVersion = null;
        info.status = null;
    }

    return info;
}

// ===================== AUDIT EXPORT =====================
export function exportLedgerAudit(): { balancesCsv: string; transactionsCsv: string } {
    return exportLedgerAuditEngine();
}

// ===================== COMMUNITY COMMONS =====================

export function createProject(proposerPubkey: string, title: string, description: string, requestedAmount: number): CommunityProject | null {
    const member = getMember(proposerPubkey);
    // A2-5: reject non-finite/non-positive requested amounts (NaN/Infinity would
    // poison the grant + conservation math). The upper bound on what can actually
    // be funded is enforced at round close by deductFromCommons (≤ commons balance).
    if (!member || !title.trim() || !Number.isFinite(requestedAmount) || requestedAmount <= 0) return null;
    // A project proposal creates an enterprise the proposer leads, so the enterprise-creation rules apply.
    if (member.status !== 'active') throw new Error(INACTIVE_MEMBER_CREATE_ERROR);
    // Checked before any write: a member whose operator switch an admin turned off must not get it back by proposing.
    if (isOperatorSwitchedOff(proposerPubkey)) throw new Error(OPERATOR_SWITCHED_OFF_CREATE_ERROR);

    const project: CommunityProject = {
        id: crypto.randomUUID(),
        title: title.trim().slice(0, 100),
        description: description.trim().slice(0, 500),
        proposerPubkey, proposerCallsign: member.callsign,
        requestedAmount: Math.round(requestedAmount * 100) / 100,
        status: 'proposed', createdAt: new Date().toISOString()
    };
    
    // For simplicity, we store projects as JSON in node_config (since they are rare)
    // Or normally we'd make a table for them. Let's store in config to avoid more schema migrations for now.
    const row = db.prepare("SELECT value FROM node_config WHERE key='commons_projects'").get() as any;
    const projects: CommunityProject[] = row ? JSON.parse(row.value) : [];
    projects.push(project);
    
    // Enterprise / Project unification (docs/the-commons.md §2.1, Slice 3):
    // A Commons project proposal IS an enterprise with lifecycle = 'bounded'.
    const now = new Date().toISOString();
    const baseCallsign = (project.title || 'Project').trim().slice(0, 40) || 'Project';
    const existingCallsign = db.prepare(
        "SELECT public_key FROM members WHERE lower(callsign) = lower(?) AND status NOT IN ('migrated', 'pruned') AND public_key != ?"
    ).get(baseCallsign, project.id) as any;
    const callsign = existingCallsign ? `${baseCallsign.slice(0, 33)}-${project.id.slice(0, 6)}` : baseCallsign;

    db.transaction(() => {
        db.prepare(`INSERT INTO node_config (key, value) VALUES ('commons_projects', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(projects));
        const existingMember = db.prepare("SELECT public_key FROM members WHERE public_key = ?").get(project.id);
        if (!existingMember) {
            db.prepare(`
                INSERT INTO members (
                    public_key, callsign, joined_at, bio, status,
                    is_treasury, earned_credit, earned_surplus,
                    purpose, goal_amount, lifecycle, paused, updated_at
                ) VALUES (?, ?, ?, ?, 'proposed', 1, 0, 0, ?, ?, 'bounded', 0, ?)
            `).run(
                project.id, callsign, now, project.description,
                project.description || project.title, project.requestedAmount, now
            );
            db.prepare("INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)").run(project.id);
            ledger.initializeGenesisAccount(project.id);
            ledger.setDecayExempt(project.id);
            if (proposerPubkey) {
                db.prepare(`
                    INSERT OR IGNORE INTO treasury_operators (
                        treasury_pubkey, member_pubkey, role, granted_at, granted_by
                    ) VALUES (?, ?, 'lead', ?, 'creator')
                `).run(project.id, proposerPubkey, now);
                raiseCreatorOperatorSwitch(proposerPubkey, project.id);
            }
        }
    })();

    broadcast({ type: 'project_created', project });
    return project;
}

export function updateProject(proposerPubkey: string, projectId: string, title: string, description: string, requestedAmount: number): boolean {
    if (!title.trim() || !Number.isFinite(requestedAmount) || requestedAmount <= 0) return false;
    const row = db.prepare("SELECT value FROM node_config WHERE key='commons_projects'").get() as any;
    const projects: CommunityProject[] = row ? JSON.parse(row.value) : [];
    const index = projects.findIndex(p => p.id === projectId);
    if (index === -1) return false;
    if (projects[index].proposerPubkey !== proposerPubkey) return false;
    if (projects[index].status !== 'proposed') return false;

    projects[index].title = title.trim().slice(0, 100);
    projects[index].description = description.trim().slice(0, 500);
    projects[index].requestedAmount = Math.round(requestedAmount * 100) / 100;
    
    const now = new Date().toISOString();
    db.transaction(() => {
        db.prepare(`UPDATE node_config SET value=? WHERE key='commons_projects'`).run(JSON.stringify(projects));
        db.prepare(`
            UPDATE members
            SET callsign = ?, purpose = ?, bio = ?, goal_amount = ?, updated_at = ?
            WHERE public_key = ?
        `).run(
            projects[index].title,
            projects[index].description || projects[index].title,
            projects[index].description,
            projects[index].requestedAmount,
            now,
            projectId
        );
    })();
    broadcast({ type: 'project_updated', project: projects[index] });
    return true;
}

export function deleteProject(proposerPubkey: string, projectId: string): boolean {
    const row = db.prepare("SELECT value FROM node_config WHERE key='commons_projects'").get() as any;
    const projects: CommunityProject[] = row ? JSON.parse(row.value) : [];
    const index = projects.findIndex(p => p.id === projectId);
    if (index === -1) return false;
    if (projects[index].proposerPubkey !== proposerPubkey) return false;
    if (projects[index].status !== 'proposed') return false;

    const acc = db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(projectId) as { balance: number } | undefined;
    if (acc && Math.abs(acc.balance) > 1e-9) {
        throw new Error(`Cannot delete enterprise account with non-zero balance (${acc.balance} Beans). Sweep or refund funds first.`);
    }
    const acct = ledger.getAccount(projectId);
    if (acct && Math.abs(acct.balance) > 0.0001) {
        throw new Error('Cannot delete project with non-zero balance: would violate ledger conservation');
    }

    projects.splice(index, 1);
    db.transaction(() => {
        db.prepare(`UPDATE node_config SET value=? WHERE key='commons_projects'`).run(JSON.stringify(projects));
        db.prepare(`DELETE FROM treasury_operators WHERE treasury_pubkey = ?`).run(projectId);
        db.prepare(`DELETE FROM accounts WHERE public_key = ? AND ABS(balance) < 0.0001`).run(projectId);
        db.prepare(`UPDATE members SET status = 'pruned', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(projectId);
        writeTombstone('projects', projectId);
        writeTombstone('members', projectId);
    })();
    broadcast({ type: 'project_deleted', projectId });
    return true;
}

export function adminRejectProject(projectId: string): boolean {
    const row = db.prepare("SELECT value FROM node_config WHERE key='commons_projects'").get() as any;
    const blobProjects: CommunityProject[] = row ? JSON.parse(row.value) : [];
    const project = blobProjects.find(p => p.id === projectId);
    let found = false;
    if (project) {
        project.status = 'rejected';
        db.prepare(`UPDATE node_config SET value=? WHERE key='commons_projects'`).run(JSON.stringify(blobProjects));
        found = true;
    }
    const member = db.prepare("SELECT public_key FROM members WHERE public_key = ? AND is_treasury = 1").get(projectId);
    if (member) {
        db.prepare("UPDATE members SET status = 'rejected' WHERE public_key = ?").run(projectId);
        found = true;
    }
    return found;
}

export function getProjects(): CommunityProject[] {
    return getAllProjects().filter(p => p.status !== 'rejected');
}

export function getAllProjects(): CommunityProject[] {
    const row = db.prepare("SELECT value FROM node_config WHERE key='commons_projects'").get() as any;
    const blobProjects: CommunityProject[] = row ? JSON.parse(row.value) : [];
    const knownIds = new Set(blobProjects.map(p => p.id));

    // Unify with bounded enterprises from members table (docs/the-commons.md §2.1, Slice 3)
    try {
        const enterprises = db.prepare(`
            SELECT m.public_key, m.callsign, m.bio, m.purpose, m.goal_amount, m.status, m.joined_at,
                   (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = m.public_key AND role = 'lead' LIMIT 1) as lead_keeper,
                   (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = m.public_key LIMIT 1) as any_keeper
            FROM members m
            WHERE m.is_treasury = 1 AND m.lifecycle = 'bounded' AND m.status NOT IN ('pruned', 'deleted')
              AND m.public_key NOT IN (SELECT id FROM projects)
        `).all() as any[];

        for (const e of enterprises) {
            const lead = e.lead_keeper || e.any_keeper || e.public_key;
            const leadMember = getMember(lead);
            const existing = blobProjects.find(p => p.id === e.public_key);
            if (existing) {
                // Keep live values from members table so blob doesn't shadow SQL
                existing.title = e.callsign || existing.title;
                existing.description = e.purpose || e.bio || existing.description;
                if (e.goal_amount != null) existing.requestedAmount = Number(e.goal_amount);
                if (e.status) existing.status = e.status.toLowerCase() as any;
            } else {
                blobProjects.push({
                    id: e.public_key,
                    title: e.callsign,
                    description: e.purpose || e.bio || '',
                    proposerPubkey: lead,
                    proposerCallsign: leadMember?.callsign || e.callsign,
                    requestedAmount: Number(e.goal_amount || 0),
                    status: (e.status || 'proposed').toLowerCase() as any,
                    createdAt: e.joined_at || new Date().toISOString(),
                });
                knownIds.add(e.public_key);
            }
        }
    } catch { }

    const prunedIds = new Set(
        (db.prepare("SELECT public_key FROM members WHERE status IN ('pruned', 'deleted')").all() as any[]).map(r => r.public_key)
    );
    return blobProjects.filter(p => !prunedIds.has(p.id) && (p.status as string) !== 'pruned' && (p.status as string) !== 'deleted');
}

export function getCommonsBalance(): number {
    return Math.round(COMMONS_BALANCE * 100) / 100;
}

/**
 * The Commons pot UNROUNDED. For snapshot/restore, not for display.
 *
 * `getCommonsBalance()` rounds to 2dp for presentation, so restoring a snapshot taken through it would
 * itself lose up to half a cent — the pot must be put back exactly as it was found.
 */
export function getCommonsBalanceExact(): number {
    return COMMONS_BALANCE;
}

export { setCommonsBalance };

/**
 * Persist the in-memory COMMONS_BALANCE to SQLite so it survives restarts.
 * Called periodically (every 5 min) and after significant balance events.
 */
export function persistCommonsBalance(): void {
    persistCommonsBalanceEngine();
}

/**
 * Persist demurrage decay events as ledger transaction rows (account → COMMONS_POOL).
 * Decay is applied lazily in-memory by LedgerManager; without these rows the
 * transaction history can never reconcile to account balances, making demurrage
 * invisible to audits. Also syncs the decayed balances/epochs back to the accounts table.
 */
export function persistDecayEvents(): void {
    persistDecayEventsEngine();
}

/**
 * Persist the demurrage PAIR — the decay debits and the matching Commons credit — in ONE commit.
 * Use this anywhere the two would otherwise be flushed as separate autocommits; see engine/audit.ts.
 */
export function persistDecayAndCommons(): void {
    persistDecayAndCommonsEngine();
}

/**
 * Ledger conservation audit. Every internal operation (transfer, fee, demurrage,
 * escrow) moves value between rows of the accounts table, so the system-wide sum
 * of balances must stay CONSTANT over time. Historical data (deleted members,
 * pre-audit demurrage) means the constant isn't necessarily zero — so the first
 * run stores a baseline in node_config and later runs alert on drift. Also flags
 * escrow wallets holding funds for settled transactions (always a bug).
 */
export function runLedgerAudit(): { sumBalances: number; baseline: number; drift: number; strandedEscrows: number; ok: boolean } {
    return runLedgerAuditEngine();
}

export function runWashSybilMetricsAudit(): { totalNegative: number; accountsNearFloor: number; delinquentCount: number; cohortAnomalies: number } {
    return runWashSybilMetricsEngine();
}

export type { ReplicaConsistency };

/**
 * Replica-fidelity check (backup side). After a backup imports a full snapshot,
 * compare the PRIMARY's row counts / total balance / commons (carried in the
 * just-pulled, SIGNED payload) against this node's local DB. A faithful replica
 * matches exactly. Cheap and side-effect-free.
 *
 * This answers a DIFFERENT question than runLedgerAudit(): that one asks "is the
 * ledger internally zero-sum?" (and is already enforced unconditionally inside
 * importRemoteState on every pull). This one asks "does the backup actually hold
 * the same data the primary sent?" — catching a partial/dropped import or silent
 * divergence that a self-consistent-but-incomplete replica would otherwise hide.
 */
export function getReplicaConsistency(payload: SyncPayload): ReplicaConsistency {
    return getReplicaConsistencyEngine(payload);
}

/**
 * Phase 1 (one-directional backup): cheap go/no-go check run at FAILOVER
 * PROMOTION, when a backup is restarted as the new primary. The backup's state
 * is whatever the last snapshot pull imported; before it starts taking live
 * writes we confirm the replicated ledger is internally consistent (zero-sum vs
 * the conservation baseline, no stranded escrows) rather than silently promoting
 * a corrupt replica. Reuses the existing conservation audit — no new math.
 *
 * Logs a prominent PASS/FAIL banner and returns the audit result so a caller
 * (boot path) can decide whether to proceed. Run once after a take-over, at the
 * next boot (services/takeover.ts, promotionAuditPending).
 */
export function promotionSanityCheck(): { sumBalances: number; baseline: number; drift: number; strandedEscrows: number; ok: boolean } {
    return promotionSanityCheckEngine();
}

// ===================== REPLICATION ACCESS LOG =====================
// The snapshot-pull endpoint hands out the entire ledger (incl. DMs + recovery
// data), so on the PRIMARY we record who pulls it — to attribute legitimate
// backup traffic AND to surface rejected attempts (a leaked-credential / probing
// signal) on the admin dashboard.

export interface ReplicationAccessEvent { at: number; ip: string; auth: 'token' | 'admin-pw' | 'rejected'; reason?: string; }
export interface ReplicationAccessLog {
    totalPulls: number;
    lastPullAt: number | null;
    lastPullIp: string | null;
    lastPullAuth: 'token' | 'admin-pw' | null;
    totalRejected: number;
    lastRejectedAt: number | null;
    lastRejectedIp: string | null;
    recent: ReplicationAccessEvent[];
}

const EMPTY_ACCESS_LOG: ReplicationAccessLog = {
    totalPulls: 0, lastPullAt: null, lastPullIp: null, lastPullAuth: null,
    totalRejected: 0, lastRejectedAt: null, lastRejectedIp: null, recent: [],
};

export function getReplicationAccessLog(): ReplicationAccessLog {
    try {
        const row = db.prepare(`SELECT value FROM node_config WHERE key='replication_access'`).get() as any;
        if (row?.value) return { ...EMPTY_ACCESS_LOG, ...JSON.parse(row.value) };
    } catch { /* fall through to empty */ }
    return { ...EMPTY_ACCESS_LOG };
}

export function recordReplicationAccess(ev: ReplicationAccessEvent): void {
    try {
        const log = getReplicationAccessLog();
        if (ev.auth === 'rejected') {
            log.totalRejected++;
            log.lastRejectedAt = ev.at;
            log.lastRejectedIp = ev.ip;
        } else {
            log.totalPulls++;
            log.lastPullAt = ev.at;
            log.lastPullIp = ev.ip;
            log.lastPullAuth = ev.auth;
        }
        log.recent = [ev, ...(log.recent || [])].slice(0, 20);
        db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('replication_access', ?)`).run(JSON.stringify(log));
    } catch (e) {
        console.warn('[Replication] Failed to record access event:', e);
    }
}

/**
 * Force-resync support (backup side): wipe the locally-replicated tables so the
 * next full snapshot import rebuilds an exact 1:1 copy with no orphan rows. The
 * upsert+tombstone importer never deletes "rows not in the snapshot", so a row the
 * primary hard-deleted without a tombstone would otherwise linger forever. Only
 * the tables exportSyncState dumps are cleared — node-local tables (push_tokens,
 * invite_codes, message_attachments, sync_cursors, node_config, …) are untouched.
 *
 * ## One exception, and it is the whole reason the primary says anything
 *
 * `keepPhotoRows` names `post_id|order_num` rows the incoming payload deliberately does NOT carry: photos the
 * PRIMARY could not read out of its own image store (`SyncPayload.photosOmitted`). Clearing those would
 * destroy the only readable copy left — the replica's — and nothing would ever send them again, because the
 * omitted rows' `updated_at` never changed on the primary. The row survives, so its `storage_key` is still
 * referenced and the daily orphan sweep leaves the object alone too.
 *
 * Rows named here are kept AS THEY ARE. Any of them the payload turns out to carry after all is upserted by
 * the import that follows, exactly as it would have been. The list has no length limit.
 *
 * THROWS if it cannot spare them, leaving every table as it found them: a committed half-clear would strand
 * the replica without the rows this argument exists to protect, so the caller must fail the resync instead.
 */
export function clearReplicatedTables(keepPhotoRows: Iterable<string> = [], opts: { invalidatedKeys?: boolean } = {}): void {
    const tables = [
        'members', 'posts', 'projects', 'ratings', 'accounts',
        'transactions', 'marketplace_transactions', 'friends', 'conversations',
        'conversation_participants', 'messages', 'abuse_reports', 'creator_channels',
        'pulse_items', 'recovery_shares', 'settlements', 'poll_votes', 'event_rsvps', 'groups', 'group_members',
        'open_joins', 'place_watches', 'directory_cache', 'join_requests', 'moderation_notices', 'tombstones',
        // Only when the incoming copy carries the main server's replaced keys (`opts.invalidatedKeys`): from a main
        // server that predates them, the keys this node holds are the only ones it has (engine/key-move.ts).
        ...(opts.invalidatedKeys ? ['invalidated_keys'] : []),
    ];
    // `post_photos` is cleared separately so the named rows can be spared by primary key. A row key that is
    // not `post_id|order_num` names no row, and is ignored rather than turned into SQL.
    const keep: { postId: string; orderNum: number }[] = [];
    for (const rowKey of keepPhotoRows) {
        const key = String(rowKey);
        const cut = key.lastIndexOf('|');
        if (cut <= 0) continue;
        const postId = key.slice(0, cut);
        const orderNum = Number(key.slice(cut + 1));
        if (!postId || !Number.isInteger(orderNum)) continue;
        keep.push({ postId, orderNum });
    }
    let kept = 0;
    db.transaction(() => {
        for (const t of tables) {
            try { db.prepare(`DELETE FROM ${t}`).run(); }
            catch (e) { console.warn(`[Resync] could not clear ${t}:`, e); }
        }
        if (keep.length === 0) {
            db.prepare(`DELETE FROM post_photos`).run();
            return;
        }
        // The spared keys travel as ONE bound JSON array, matched through `json_each`, so the statement is
        // the same size whether a single row is spared or fifty thousand. An `OR`-ed predicate per pair is
        // the obvious spelling and a trap: SQLite parses it left-deep and throws "Expression tree is too
        // large (maximum depth 1000)" from about 999 pairs on — and the case this argument exists for, a
        // primary whose images directory is lost or unmounted, omits EVERY evacuated photo, which on a live
        // node is thousands of rows. Values stay bound, never interpolated, exactly as before.
        //
        // Nothing here is caught. A clear that half-happened is the one outcome worse than a resync that
        // failed: swallowing this let the transaction commit with `post_photos` not cleared at all, which
        // left the orphan rows a resync exists to remove and reported "KEEPING 0" while doing it. Throwing
        // rolls the whole clear back, so the replica keeps the data it had and the caller retries.
        const keepJson = JSON.stringify(keep.map(k => `${k.postId}|${k.orderNum}`));
        kept = (db.prepare(
            `SELECT COUNT(*) AS n FROM post_photos WHERE (post_id || '|' || order_num) IN (SELECT value FROM json_each(?))`,
        ).get(keepJson) as any)?.n || 0;
        db.prepare(
            `DELETE FROM post_photos WHERE (post_id || '|' || order_num) NOT IN (SELECT value FROM json_each(?))`,
        ).run(keepJson);
    })();
    // The directory's listed communities are kept in memory for the reads; the table is empty now.
    forgetListedCommunities();
    if (keep.length > 0) {
        console.log(
            `🧹 [Resync] Cleared replicated tables, KEEPING ${kept} of the ${keep.length} photo row(s) the primary `
            + 'could not read out of its own store — this replica holds the only readable copy of those, and the '
            + 'incoming payload does not carry them.',
        );
    } else {
        console.log('🧹 [Resync] Cleared replicated tables — awaiting fresh snapshot import.');
    }
}

// ===================== PUSH NOTIFICATIONS =====================

/**
 * Adds this key's row for the device token and touches no other key's row. Every community a phone registered with
 * holds its token, so a take-over by token would let any of them remove a member's rows and silence their recovery
 * alerts (#1184 review 4110460184). The phone removes a leaving account's rows itself, signed by that account's key
 * (apps/native utils/account-leaves-phone.ts). The key is the request's signer (routes/community.ts).
 */
export function registerPushToken(publicKey: string, token: string, platform: string = 'ios'): boolean {
    try {
        db.prepare(`INSERT OR REPLACE INTO push_tokens (public_key, token, platform) VALUES (?, ?, ?)`).run(publicKey, token, platform);
        console.log(`[Push] Registered token for ${publicKey.slice(0, 8)}: ${token.slice(0, 20)}...`);
        return true;
    } catch (e) {
        console.error('[Push] Failed to register token:', e);
        return false;
    }
}

export function removePushToken(publicKey: string, token?: string): boolean {
    try {
        if (token) {
            db.prepare(`DELETE FROM push_tokens WHERE public_key = ? AND token = ?`).run(publicKey, token);
        } else {
            // Remove all tokens for this user (logout from all devices)
            db.prepare(`DELETE FROM push_tokens WHERE public_key = ?`).run(publicKey);
        }
        console.log(`[Push] Removed token(s) for ${publicKey.slice(0, 8)}`);
        return true;
    } catch (e) {
        console.error('[Push] Failed to remove token:', e);
        return false;
    }
}

export function getPushTokens(publicKey: string): { token: string; platform: string }[] {
    return (db.prepare(`SELECT token, platform FROM push_tokens WHERE public_key = ?`).all(publicKey) as any[]);
}

// ===================== MEMBER PREFERENCES =====================

export function getMemberPreference(publicKey: string, prefKey: string): string {
    const row = db.prepare(`SELECT pref_value FROM member_preferences WHERE public_key = ? AND pref_key = ?`).get(publicKey, prefKey) as any;
    return row?.pref_value ?? 'true'; // Default to 'true' (enabled)
}

/**
 * The preferences a member sets (setMemberPreferences), and the only ones they set: which pushes reach their phone, one per
 * dispatchPushNotification category (`notify_<category>`), and their event reminders, as the apps send them. Holiday mode is
 * not one of them; setHolidayMode alone switches it, after its open-trades check. A visitor's row sets these too
 * (visitor-allowlist.ts).
 */
export const PUSH_PREFERENCE_KEYS: readonly string[] = ['notify_chat', 'notify_marketplace', 'notify_escrow', 'notify_recovery', 'eventReminderOffsets'];

/** A body of preferences that names push settings and nothing else: an object, not a list, whose every key is in PUSH_PREFERENCE_KEYS. */
export function namesOnlyPushSettings(preferences: unknown): preferences is Record<string, unknown> {
    return !!preferences && typeof preferences === 'object' && !Array.isArray(preferences)
        && Object.keys(preferences).every(key => PUSH_PREFERENCE_KEYS.includes(key));
}

export const HOLIDAY_NOT_A_PREFERENCE_MESSAGE =
    "Holiday mode isn't saved with your preferences. Switch it with Holiday mode in Settings, which first checks you have no trades in progress.";
export const NOT_A_PUSH_SETTING_MESSAGE =
    `Only your notification settings are saved here: ${PUSH_PREFERENCE_KEYS.join(', ')}, each sent by name.`;
export const PUSH_TOGGLE_MESSAGE = 'A notification setting is on or off: send true or false.';

/**
 * Every preference this member has, with the defaults for the ones they have never touched, and holiday mode once
 * setHolidayMode has written it. A row under any other key (setMemberPreferences stored whatever it was given until it
 * took only PUSH_PREFERENCE_KEYS) stays in the table and is served to nobody.
 *
 * `eventReminderOffsets` is the odd one out and is spelled in camelCase, as a real array: the notification
 * toggles are booleans-as-strings because that is all they have ever needed, while a reminder choice is a
 * list of minutes (docs/events-on-the-map.md §2.2). Serving it here rather than as a raw `pref_value` means
 * the client never has to know it is stored as JSON, and never has to guess the `[1440]` default.
 */
export function getMemberPreferences(publicKey: string): Record<string, string | number[]> {
    const rows = db.prepare(`SELECT pref_key, pref_value FROM member_preferences WHERE public_key = ?`).all(publicKey) as any[];
    const prefs: Record<string, string | number[]> = {
        notify_chat: 'true',
        notify_marketplace: 'true',
        notify_escrow: 'true',
        notify_recovery: 'true',
    };
    for (const r of rows) {
        // The stored reminders key (EVENT_REMINDER_PREF_KEY) isn't one of these either: it is served as eventReminderOffsets below.
        if (r.pref_key === 'holiday_mode' || PUSH_PREFERENCE_KEYS.includes(r.pref_key)) prefs[r.pref_key] = r.pref_value;
    }
    prefs.eventReminderOffsets = getMemberDefaultReminderOffsets(publicKey);
    return prefs;
}

/**
 * THROWS on a body it refuses: a key that isn't one of PUSH_PREFERENCE_KEYS (holiday mode among them, which only
 * setHolidayMode switches, after its open-trades check), a notification toggle that isn't true or false, or a rejected
 * `eventReminderOffsets`. Still returns false for a storage failure — the route turns the throw into a 400 and the false
 * into its existing `{ success: false }`. A refused body writes nothing: silently storing four valid toggles and dropping
 * a fifth, invalid value is how a member ends up believing they set a reminder they will never get.
 */
export function setMemberPreferences(publicKey: string, preferences: unknown): boolean {
    // Validated BEFORE the transaction opens: anything refused here refuses the whole write.
    if (!!preferences && typeof preferences === 'object' && Object.prototype.hasOwnProperty.call(preferences, 'holiday_mode')) {
        throw new Error(HOLIDAY_NOT_A_PREFERENCE_MESSAGE);
    }
    if (!namesOnlyPushSettings(preferences)) throw new Error(NOT_A_PUSH_SETTING_MESSAGE);
    for (const [key, value] of Object.entries(preferences)) {
        if (key !== 'eventReminderOffsets' && typeof value !== 'boolean') throw new Error(PUSH_TOGGLE_MESSAGE);
    }
    const hasOffsets = Object.prototype.hasOwnProperty.call(preferences, 'eventReminderOffsets');
    const offsets = hasOffsets ? parseReminderOffsets(preferences.eventReminderOffsets) : undefined;
    if (hasOffsets && offsets === null) {
        // There is no "my default" above a default. `[]` is how a member turns reminders off.
        throw new Error(BAD_OFFSETS_MESSAGE);
    }
    try {
        const stmt = db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?)`);
        const tx = db.transaction(() => {
            for (const [key, value] of Object.entries(preferences)) {
                if (key === 'eventReminderOffsets') continue;
                stmt.run(publicKey, key, String(value));
            }
            if (offsets != null) setMemberDefaultReminderOffsets(publicKey, offsets);
        });
        tx();
        console.log(`[Prefs] Updated preferences for ${publicKey.slice(0, 8)}:`, preferences);
        return true;
    } catch (e) {
        console.error('[Prefs] Failed to set preferences:', e);
        return false;
    }
}

// ===================== HOLIDAY MODE =====================

// Is this member on holiday? Queried directly (NOT via getMemberPreference, which defaults
// UNSET keys to 'true' — that default would read every member as away). Absent → false.
export function isOnHoliday(publicKey: string): boolean {
    const row = db.prepare(`SELECT pref_value FROM member_preferences WHERE public_key = ? AND pref_key = 'holiday_mode'`).get(publicKey) as any;
    return row?.pref_value === 'true';
}

// Open (in-flight) trades where this member is a party — a requested or escrow-funded deal.
// Holiday mode may only be switched ON when this is zero: going away mid-deal would strand a
// counterparty's escrow or an open request.
export function countOpenTrades(publicKey: string): number {
    const row = db.prepare(
        `SELECT COUNT(*) as n FROM marketplace_transactions WHERE (buyer_pubkey = ? OR seller_pubkey = ?) AND status IN ('requested','pending')`
    ).get(publicKey, publicKey) as any;
    return row?.n || 0;
}

// Stable prefix so clients can detect the holiday-block and prompt "turn off holiday mode".
export const HOLIDAY_MODE_ERROR = 'HOLIDAY_MODE: turn off holiday mode in Settings before trading.';

export function assertNotOnHoliday(publicKey: string): void {
    if (isOnHoliday(publicKey)) throw new Error(HOLIDAY_MODE_ERROR);
}

/**
 * Switch holiday mode on/off. Turning it ON is gated on having zero open trades — otherwise a
 * counterparty would be left with escrow locked or an unanswered request. On holiday, the
 * member's Offers are hidden from the marketplace feed (getPosts) and they can neither post nor
 * initiate trades (assertNotOnHoliday). No trades or floors change. Throws with `.openTrades`
 * set when blocked so the client can name the count.
 */
export function setHolidayMode(publicKey: string, enabled: boolean): { ok: true; openTrades: number } {
    if (!getActingMember(publicKey)) throw new Error('Member not found');
    const open = countOpenTrades(publicKey);
    if (enabled && open > 0) {
        const err: any = new Error(`You have ${open} active trade${open === 1 ? '' : 's'} in progress. Complete or cancel ${open === 1 ? 'it' : 'them'} before switching on holiday mode.`);
        err.openTrades = open;
        throw err;
    }
    db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'holiday_mode', ?)`).run(publicKey, enabled ? 'true' : 'false');
    broadcast({ type: 'profile_updated', publicKey });
    return { ok: true, openTrades: open };
}

// ===================== GENERIC PUSH DISPATCHER =====================

/**
 * Generic push notification dispatcher with category-based preference gating,
 * app icon badge counts, iOS threadId grouping, and Android channelId routing.
 * Fire-and-forget pattern. Returns how many notifications it handed to the push service
 * (one per registered phone of each recipient who has this category on).
 */
export function dispatchPushNotification(
    targetPubkeys: string[],
    actorPubkey: string,
    title: string,
    body: string,
    data: Record<string, any>,
    categoryId: 'chat' | 'marketplace' | 'escrow' | 'recovery'
): number {
    // Filter out the actor and SYSTEM from targets
    const recipients = targetPubkeys.filter(pk => pk !== actorPubkey && pk !== 'SYSTEM');
    if (recipients.length === 0) return 0;

    const prefKey = `notify_${categoryId}`;
    
    // Map categoryId to Android channelId
    const channelMap: Record<string, string> = {
        chat: 'chat',
        marketplace: 'marketplace',
        escrow: 'escrow',
        recovery: 'recovery',
    };

    // Map categoryId to notification sound
    const soundMap: Record<string, string> = {
        chat: 'default',      // Softer sound for chat (uses system default for now)
        marketplace: 'default',
        escrow: 'default',
        recovery: 'default',
    };

    const allMessages: any[] = [];

    for (const pk of recipients) {
        // Check user's notification preference for this category
        const pref = getMemberPreference(pk, prefKey);
        if (pref === 'false') {
            console.log(`[Push] Skipped ${pk.slice(0, 8)} — ${prefKey} disabled`);
            continue;
        }

        const tokens = getPushTokens(pk);
        if (tokens.length === 0) continue;

        // The badge sets the app icon: the unread lines in the chats the member's list shows, and no others.
        const unreadCounts = getListedUnreadCounts(pk);
        const totalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);

        for (const { token, platform } of tokens) {
            const msg: any = {
                to: token,
                sound: soundMap[categoryId] || 'default',
                title,
                body,
                data,
                badge: totalUnread,
                categoryId,
            };

            // iOS: threadId for notification grouping on lock screen
            if (platform === 'ios' && data.conversationId) {
                msg._contentAvailable = true;
            }

            // Android: route to the correct notification channel
            if (platform === 'android') {
                msg.channelId = channelMap[categoryId] || 'default';
            }

            allMessages.push(msg);
        }
    }

    if (allMessages.length === 0) return 0;

    // Batch send to Expo (max 100 per request)
    const batches: typeof allMessages[] = [];
    for (let i = 0; i < allMessages.length; i += 100) {
        batches.push(allMessages.slice(i, i + 100));
    }

    for (const batch of batches) {
        fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch),
        }).then(res => {
            if (!res.ok) console.warn(`[Push] Expo API returned ${res.status}`);
            else console.log(`[Push] Sent ${batch.length} notification(s) for category=${categoryId}`);
        }).catch(err => {
            console.warn('[Push] Failed to send push notification:', err.message);
        });
    }
    return allMessages.length;
}

/**
 * The members a push of this category would reach now, as dispatchPushNotification decides it: a phone of theirs has
 * registered its token here, and they haven't switched the category off. Only `publicKey`, when given.
 */
export function pushableMembers(categoryId: 'chat' | 'marketplace' | 'escrow' | 'recovery', publicKey?: string): Set<string> {
    const off = `NOT EXISTS (SELECT 1 FROM member_preferences p WHERE p.public_key = t.public_key AND p.pref_key = ? AND p.pref_value = 'false')`;
    const rows = (publicKey === undefined
        ? db.prepare(`SELECT DISTINCT t.public_key AS pk FROM push_tokens t WHERE ${off}`).all(`notify_${categoryId}`)
        : db.prepare(`SELECT DISTINCT t.public_key AS pk FROM push_tokens t WHERE t.public_key = ? AND ${off}`).all(publicKey, `notify_${categoryId}`)) as { pk: string }[];
    return new Set(rows.map(r => r.pk));
}

/**
 * Dispatches Expo Push Notifications for Escrow lifecycle events.
 * Delegates to the generic dispatchPushNotification with categoryId='escrow'.
 */
export function sendPushNotification(postId: string, type: SystemMessageType, meta: SystemMessageMetadata, participantPubkeys: string[]) {
    // Build notification payload based on event type
    const post = db.prepare("SELECT title FROM posts WHERE id = ?").get(postId) as any;
    const postTitle = post?.title || 'a post';
    const actorMember = meta.actorPubkey ? (getMember(meta.actorPubkey) as any) : null;
    const actorName = actorMember?.callsign || 'Someone';

    const notificationMap: Partial<Record<SystemMessageType, { title: string; body: string; data: any }>> = {
        [SystemMessageType.ESCROW_CREATED]: {
            title: '🔒 Escrow Initialized',
            body: `An escrow has been created for "${postTitle}"`,
            data: { screen: 'post', postId }
        },
        [SystemMessageType.ESCROW_FUNDED]: {
            title: '🔒 Credits Locked in Escrow',
            body: `${meta.amount} Beans placed in escrow for "${postTitle}"`,
            data: { screen: 'post', postId }
        },
        [SystemMessageType.ESCROW_RELEASED]: {
            title: '✅ Credits Released!',
            body: `Payment of ${meta.amount} Beans released for "${postTitle}"`,
            data: { screen: 'post', postId }
        },
        [SystemMessageType.ESCROW_CANCELLED]: {
            title: '❌ Escrow Cancelled',
            body: `Escrow cancelled for "${postTitle}". Funds refunded.`,
            data: { screen: 'post', postId }
        },
        [SystemMessageType.DISPUTE_OPENED]: {
            title: '⚠️ Dispute Opened',
            body: `A dispute has been opened for "${postTitle}"`,
            data: { screen: 'post', postId }
        },
        [SystemMessageType.ESCROW_DISPUTE_RESOLVED]: {
            title: '⚖️ Dispute Resolved',
            body: `Dispute arbitrated by ${meta.resolvedByName || 'a community admin'} for "${postTitle}": ${meta.resolution || 'Resolved'}`,
            data: { screen: 'post', postId }
        },
        [SystemMessageType.REVIEW_LEFT]: {
            title: '⭐ New Review',
            body: `${actorName} left a review on "${postTitle}"`,
            data: { screen: 'post', postId }
        }
    };

    const notification = notificationMap[type];
    if (!notification) return;

    dispatchPushNotification(
        participantPubkeys,
        meta.actorPubkey || 'SYSTEM',
        notification.title,
        notification.body,
        notification.data,
        'escrow'
    );
}

// ===================== GROUPS & CONVENOR MODERATION (§9) =====================

// Seeded from the clock like the other list versions (engine/versions.ts): starting at 1 on every boot handed
// out ETags a client had already cached from before a restart or a restore, and it got a 304 for stale groups.
let _groupsVersion = Date.now();
export function getGroupsVersion(): number { return _groupsVersion; }
export function bumpGroupsVersion(): void { _groupsVersion++; }

function getGroupActiveMemberRecipients(groupId: string, extraPubkeys: string[] = []): string[] {
    const rows = db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(groupId) as any[];
    return Array.from(new Set([...rows.map(r => r.member_pubkey), ...extraPubkeys.filter(Boolean)]));
}

/**
 * A group's picture as it is stored: it rides in every group listing, so without its metadata (G9a-3). Held to the
 * photo rule first (a JPEG, PNG, WebP or GIF whose bytes really are one, as a data URL or bare base64), because a
 * format the strip does not know — HEIC, AVIF, TIFF — would keep its GPS, and no app sends one. Any other string
 * (a URL, a `bundled://` name) is unchanged.
 */
function storableGroupPicture(avatarUrl: string | undefined): string | undefined {
    if (!isAcceptablePhotoValue(avatarUrl)) throw new Error(AVATAR_FORMAT_ERROR);
    return stripImageValue(avatarUrl);
}

export function createGroup(params: CreateGroupParams): Group {
    const res = createGroupEngine(db, { ...params, avatarUrl: storableGroupPicture(params.avatarUrl) });
    // Every group owns its chat from the start, with its convenor in it (decision 3).
    ensureGroupThread(res.id);
    bumpGroupsVersion();
    if (res.joinPolicy === 'open') {
        broadcast({ type: 'group_created', group: res });
    } else {
        const recipients = getGroupActiveMemberRecipients(res.id, [params.createdBy]);
        broadcast({ type: 'group_created', group: res }, recipients);
    }
    return res;
}

export function getGroup(idOrSlug: string, viewerPubkey?: string): Group | null {
    return getGroupEngine(db, idOrSlug, viewerPubkey);
}

export function listGroups(filter?: ListGroupsFilter, viewerPubkey?: string): Group[] {
    return listGroupsEngine(db, filter, viewerPubkey);
}

export function getGroupMembers(groupId: string, filter?: { status?: GroupMemberStatus; role?: GroupRole }): GroupMember[] {
    return getGroupMembersEngine(db, groupId, filter);
}

export function getGroupMember(groupId: string, memberPubkey: string): GroupMember | null {
    return getGroupMemberEngine(db, groupId, memberPubkey);
}

export function isGroupConvenor(groupId: string, memberPubkey: string): boolean {
    return isGroupConvenorEngine(db, groupId, memberPubkey);
}

export function isGroupMember(groupId: string, memberPubkey: string): boolean {
    return isGroupMemberEngine(db, groupId, memberPubkey);
}

export function getGroupLead(groupId: string): string | null {
    return getGroupLeadEngine(db, groupId);
}

export function isGroupLead(groupId: string, memberPubkey: string): boolean {
    return isGroupLeadEngine(db, groupId, memberPubkey);
}

/**
 * The lead convenor hands the lead on (2026-09-23). An active member becomes a convenor in the same step; the
 * outgoing lead stays a convenor. The group's chat says so — who leads a group is the group's business, not a
 * quiet database change.
 */
/**
 * A convenor's or lead's action on a group: only from a member of this node (isNodeMember). The group's own role tests
 * read group_members alone, which a prune and a pending re-key both leave as they were, so a pruned convenor, or the
 * old key of one being re-keyed, would otherwise still run the group. (Succession needs nothing more: its electorate
 * already asks for members.status = 'active', engine/group-succession.ts.)
 */
function assertGroupActorIsMember(actorPubkey: string): void {
    if (!isNodeMember(actorPubkey)) throw new Error(`UNAUTHORIZED: ${NOT_A_MEMBER_ERROR}`);
}

export function handOverGroupLead(groupId: string, leadPubkey: string, targetPubkey: string): GroupMember {
    assertGroupActorIsMember(leadPubkey);
    const res = handOverGroupLeadEngine(db, groupId, leadPubkey, targetPubkey);
    try {
        syncGroupThreadMembership(groupId, targetPubkey);
        postGroupSystemLine(getMessagingCb(), groupId, GroupSystemType.LEAD_HANDED_OVER,
            `${callsignOf(leadPubkey)} made ${callsignOf(targetPubkey)} the group's lead convenor`,
            { actorPubkey: leadPubkey, targetPubkey, role: res.role });
    } catch (e) { console.warn('[Groups] Could not write the lead hand-over line:', e); }
    bumpGroupsVersion();
    const recipients = getGroupActiveMemberRecipients(groupId, [targetPubkey]);
    broadcast({ type: 'group_member_updated', groupId, member: res }, recipients);
    const group = getGroupEngine(db, groupId);
    if (group) broadcast({ type: 'group_updated', group }, recipients);
    return res;
}

export function getMemberGroupIds(memberPubkey: string): string[] {
    return getMemberGroupIdsEngine(db, memberPubkey);
}

const ROLE_WORDS: Record<GroupRole, string> = { convenor: 'a convenor', member: 'a member', observer: 'an observer' };

/**
 * After any membership change: the chat's participant mirror follows the group, and a person who has just
 * become an active member gets a "joined" line (decision 12). A pending request or an invitation writes
 * nothing — they are not in the group yet.
 */
function afterGroupMembershipChange(groupId: string, targetPubkey: string, wasActive: boolean, meta: Record<string, unknown> = {}): void {
    try {
        syncGroupThreadMembership(groupId, targetPubkey);
        const nowActive = isGroupMemberEngine(db, groupId, targetPubkey);
        if (!wasActive && nowActive) {
            postGroupSystemLine(getMessagingCb(), groupId, GroupSystemType.MEMBER_JOINED,
                `${callsignOf(targetPubkey)} joined`, { targetPubkey, ...meta });
        }
    } catch (e) { console.warn('[Groups] Could not update the group chat after a membership change:', e); }
}

export function joinGroup(groupId: string, memberPubkey: string): GroupMember {
    const wasActive = isGroupMemberEngine(db, groupId, memberPubkey);
    const res = joinGroupEngine(db, groupId, memberPubkey);
    afterGroupMembershipChange(groupId, memberPubkey, wasActive);
    bumpGroupsVersion();
    const recipients = getGroupActiveMemberRecipients(groupId, [memberPubkey]);
    broadcast({ type: 'group_member_updated', groupId, member: res }, recipients);
    return res;
}

export function setMemberRole(groupId: string, convenorPubkey: string, targetPubkey: string, newRole: GroupRole): GroupMember {
    assertGroupActorIsMember(convenorPubkey);
    const before = getGroupMemberEngine(db, groupId, targetPubkey);
    const res = setMemberRoleEngine(db, groupId, convenorPubkey, targetPubkey, newRole);
    try {
        syncGroupThreadMembership(groupId, targetPubkey);
        if (before && before.status === 'active' && before.role !== res.role) {
            const text = convenorPubkey === targetPubkey
                ? `${callsignOf(targetPubkey)} is now ${ROLE_WORDS[res.role]}`
                : `${callsignOf(convenorPubkey)} made ${callsignOf(targetPubkey)} ${ROLE_WORDS[res.role]}`;
            postGroupSystemLine(getMessagingCb(), groupId, GroupSystemType.ROLE_CHANGED, text,
                { actorPubkey: convenorPubkey, targetPubkey, role: res.role, previousRole: before.role });
        }
    } catch (e) { console.warn('[Groups] Could not write the role-change line:', e); }
    bumpGroupsVersion();
    const recipients = getGroupActiveMemberRecipients(groupId, [targetPubkey]);
    broadcast({ type: 'group_member_updated', groupId, member: res }, recipients);
    return res;
}

export function removeGroupMember(groupId: string, actorPubkey: string, targetPubkey: string): boolean {
    // Leaving is anyone's own business; removing someone else is a convenor's.
    if (actorPubkey !== targetPubkey) assertGroupActorIsMember(actorPubkey);
    const wasActive = isGroupMemberEngine(db, groupId, targetPubkey);
    const res = removeGroupMemberEngine(db, groupId, actorPubkey, targetPubkey);
    if (res) {
        try {
            // Out of the chat at once (and out of its live updates and pushes).
            syncGroupThreadMembership(groupId, targetPubkey);
            if (wasActive) {
                const self = actorPubkey === targetPubkey;
                postGroupSystemLine(getMessagingCb(), groupId,
                    self ? GroupSystemType.MEMBER_LEFT : GroupSystemType.MEMBER_REMOVED,
                    self ? `${callsignOf(targetPubkey)} left` : `${callsignOf(actorPubkey)} removed ${callsignOf(targetPubkey)}`,
                    { actorPubkey, targetPubkey },
                    // The person removed gets the line that explains why the chat just closed on them.
                    self ? [] : [targetPubkey]);
            }
        } catch (e) { console.warn('[Groups] Could not update the group chat after a removal:', e); }
        bumpGroupsVersion();
        const recipients = getGroupActiveMemberRecipients(groupId, [targetPubkey]);
        broadcast({ type: 'group_member_removed', groupId, memberPubkey: targetPubkey }, recipients);
    }
    return res;
}

export function updateGroupPolicy(groupId: string, convenorPubkey: string, joinPolicy: JoinPolicy): Group {
    assertGroupActorIsMember(convenorPubkey);
    const res = updateGroupPolicyEngine(db, groupId, convenorPubkey, joinPolicy);
    bumpGroupsVersion();
    if (res.joinPolicy === 'open') {
        broadcast({ type: 'group_updated', group: res });
    } else {
        const recipients = getGroupActiveMemberRecipients(groupId);
        broadcast({ type: 'group_updated', group: res }, recipients);
    }
    return res;
}

export function updateGroup(groupId: string, convenorPubkey: string, updates: UpdateGroupParams): Group {
    assertGroupActorIsMember(convenorPubkey);
    const res = updateGroupEngine(db, groupId, convenorPubkey, { ...updates, avatarUrl: storableGroupPicture(updates.avatarUrl) });
    // The chat is titled by the group's name; a rename carries over (and replicates: the conversations import
    // updates name on conflict).
    db.prepare("UPDATE conversations SET name = ? WHERE id = ? AND type = 'group_thread'").run(res.name, groupId);
    bumpGroupsVersion();
    if (res.joinPolicy === 'open') {
        broadcast({ type: 'group_updated', group: res });
    } else {
        const recipients = getGroupActiveMemberRecipients(groupId);
        broadcast({ type: 'group_updated', group: res }, recipients);
    }
    return res;
}

export function approveGroupMember(groupId: string, convenorPubkey: string, targetPubkey: string): GroupMember {
    assertGroupActorIsMember(convenorPubkey);
    const wasActive = isGroupMemberEngine(db, groupId, targetPubkey);
    const res = approveGroupMemberEngine(db, groupId, convenorPubkey, targetPubkey);
    afterGroupMembershipChange(groupId, targetPubkey, wasActive, { approvedBy: convenorPubkey });
    bumpGroupsVersion();
    const recipients = getGroupActiveMemberRecipients(groupId, [targetPubkey]);
    broadcast({ type: 'group_member_updated', groupId, member: res }, recipients);
    return res;
}

export function inviteGroupMember(groupId: string, convenorPubkey: string, targetPubkey: string, role: GroupRole = 'member'): GroupMember {
    assertGroupActorIsMember(convenorPubkey);
    const wasActive = isGroupMemberEngine(db, groupId, targetPubkey);
    const res = inviteGroupMemberEngine(db, groupId, convenorPubkey, targetPubkey, role);
    // Inviting someone who had asked to join admits them at once.
    afterGroupMembershipChange(groupId, targetPubkey, wasActive, { approvedBy: convenorPubkey });
    bumpGroupsVersion();
    const convenors = db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND role = 'convenor' AND status = 'active'").all(groupId) as any[];
    const recipients = Array.from(new Set([...convenors.map(r => r.member_pubkey), targetPubkey]));
    broadcast({ type: 'group_member_invited', groupId, member: res }, recipients);
    return res;
}

// ===================== A GROUP'S CHAT, CONVENOR SUCCESSION, "YOUR GROUPS" =====================

export function getGroupThread(groupId: string, viewerPubkey: string | undefined, limit = 50, offset = 0): GroupThreadView {
    return getGroupThreadEngine(groupId, viewerPubkey, limit, offset);
}

export function postGroupThreadMessage(groupId: string, authorPubkey: string, text: string, clientId?: string, replyToId?: string): EventThreadMessage {
    return postGroupThreadMessageEngine(getMessagingCb(), groupId, authorPubkey, text, clientId, replyToId);
}

export function removeGroupThreadMessage(groupId: string, messageId: string, actorPubkey: string): EventThreadMessage {
    assertGroupActorIsMember(actorPubkey);
    return removeGroupThreadMessageEngine(getMessagingCb(), groupId, messageId, actorPubkey);
}

export function proposeGroupConvenor(groupId: string, proposerPubkey: string, candidatePubkey: string) {
    const res = proposeGroupConvenorEngine(getMessagingCb(), groupId, proposerPubkey, candidatePubkey);
    bumpGroupsVersion();
    return res;
}

export function voteGroupConvenor(proposalId: string, voterPubkey: string, choice: 'yes' | 'no') {
    const res = voteGroupConvenorEngine(getMessagingCb(), proposalId, voterPubkey, choice);
    bumpGroupsVersion();
    return res;
}

export function getGroupSuccession(groupId: string, viewerPubkey?: string) {
    const res = getGroupSuccessionEngine(getMessagingCb(), groupId, viewerPubkey);
    // The convenor's last activity to the UTC day and whole days, as everywhere else it is served (#923,
    // answer I): an exact time would let members time a vote to its voter. The convenor sees their own.
    const s = res.silence;
    return {
        ...res,
        silence: {
            ...s,
            lastActiveAt: s.convenorPubkey ? lastActiveForViewer(s.lastActiveAt, s.convenorPubkey, viewerPubkey) : null,
            daysInactive: Math.floor(s.daysInactive),
        },
    };
}

export function tickGroupSuccession(asOfMs?: number): { passed: number; closed: number } {
    const res = tickGroupSuccessionEngine(getMessagingCb(), asOfMs);
    if (res.passed + res.closed > 0) bumpGroupsVersion();
    return res;
}

export function listYourChats(pubkey: string) {
    return listYourChatsEngine(pubkey);
}

export function deleteGroupPost(groupId: string, convenorPubkey: string, postId: string): boolean {
    assertGroupActorIsMember(convenorPubkey);
    const res = deleteGroupPostEngine(db, groupId, convenorPubkey, postId);
    if (res) {
        bumpPostsVersion();
        const recipients = getGroupActiveMemberRecipients(groupId);
        // Only a group post is deleted here (deleteGroupPostEngine matches audience_scope = 'group').
        broadcast({ type: 'post_removed', id: postId, audienceScope: 'group' }, recipients);
    }
    return res;
}
