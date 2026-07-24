import crypto from 'node:crypto';
import { LedgerManager, COMMONS_BALANCE, setCommonsBalance, getTier, getGenesisEarnedCredit, vouchCreditForLevel, grantedCreditForTier, offerCapForCount, offersRequiredForDepth, OFFER_BANDS, PROTOCOL_CONSTANTS, TRANSACTION_FEE_RATE } from '@beanpool/core';
import type { TrustStats, TierInfo, GenesisInviteType, VouchLevel, TierName } from '@beanpool/core';
import * as engine from '@beanpool/engine';
import type { WashAnalysis } from '@beanpool/engine';
export type { WashAnalysis };
import { getThresholds, getLocalConfig } from './config/local-config.js';
import { db, initSchema, migrateLegacyState, writeTombstone, setBalanceMutationHook } from './db/db.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPrivateKey } from './p2p.js';
import { publicKeyToProtobuf, publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { ledger } from './engine/ledger.js';
import {
    persistCommonsBalance as persistCommonsBalanceEngine,
    runWashSybilMetricsAudit as runWashSybilMetricsEngine,
    getReplicaConsistency as getReplicaConsistencyEngine,
    exportLedgerAudit as exportLedgerAuditEngine,
    persistDecayEvents as persistDecayEventsEngine,
    runLedgerAudit as runLedgerAuditEngine,
    promotionSanityCheck as promotionSanityCheckEngine,
    type ReplicaConsistency
} from './engine/audit.js';
import {
    recordActivity,
    seedGenesisMember,
    registerMember as registerMemberEngine,
    registerVisitor,
    updateProfile as updateProfileEngine
} from './engine/members.js';
import {
    generateInvite,
    adminGenerateInvite,
    redeemInvite as redeemInviteEngine,
    redeemOfflineTicket as redeemOfflineTicketEngine
} from './engine/invites.js';
import {
    getMember as getMemberEngine,
    getMembers as getMembersEngine,
    getAllMembers as getAllMembersEngine,
    checkInvite as checkInviteEngine,
    getInvitesByMember as getInvitesByMemberEngine,
    getInviteTree as getInviteTreeEngine,
    getProfile as getProfileEngine,
    getProfiles as getProfilesEngine,
    getAllProfiles as getAllProfilesEngine,
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
    getPostCount as getPostCountEngine,
    getActivePostCount as getActivePostCountEngine,
    hasListedOffer as hasListedOfferEngine,
    hasLiveOffer as hasLiveOfferEngine,
    liveOfferCount as liveOfferCountEngine,
    usableFloor as usableFloorEngine,
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
    type SyncPayload
} from '@beanpool/engine';
import {
    addRating,
    addFriend,
    removeFriend,
    setGuardian
} from './engine/social.js';
import {
    createPost as createPostEngine,
    removePost as removePostEngine,
    updatePost as updatePostEngine,
    pausePost as pausePostEngine,
    resumePost as resumePostEngine,
    adminDeletePost as adminDeletePostEngine,
    adminBulkDeletePosts as adminBulkDeletePostsEngine
} from './engine/posts.js';
import {
    requestPost as requestPostEngine,
    approvePostRequest as approvePostRequestEngine,
    rejectPostRequest as rejectPostRequestEngine,
    cancelPostRequest as cancelPostRequestEngine,
    acceptPost as acceptPostEngine,
    completePostTransaction as completePostTransactionEngine,
    cancelPostTransaction as cancelPostTransactionEngine
} from './engine/escrow.js';
import {
    createConversation as createConversationEngine,
    sendMessage as sendMessageEngine,
    toggleMessageReaction as toggleMessageReactionEngine,
    editMessage as editMessageEngine,
    MESSAGE_EDIT_WINDOW_MS,
    injectSystemMessage as injectSystemMessageEngine,
    markConversationRead as markConversationReadEngine,
    ensureTransactionConversation as ensureTransactionConversationEngine,
    migrateConsolidateConversations as migrateConsolidateConversationsEngine,
    repairConsolidatedMessagesMetadata as repairConsolidatedMessagesMetadataEngine
} from './engine/messaging.js';
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
    type ImportResult
} from './engine/sync.js';



// Load synonym map for FTS5 search keyword expansion
const __filename_se = fileURLToPath(import.meta.url);
const __dirname_se = dirname(__filename_se);
const synonymMap: Record<string, string[]> = (() => {
    try {
        const raw = readFileSync(join(__dirname_se, 'db', 'synonyms.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        delete parsed._meta;
        return parsed;
    } catch (e) {
        console.warn('[FTS] Failed to load synonyms.json, search keywords will be minimal:', e);
        return {};
    }
})();

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
    reason: string;
    createdAt: string;
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
    votes: { pubkey: string; weight: number; creditsUsed?: number }[];
    createdAt: string;
    fundedAt?: string;
}

export interface VotingRound {
    id: string;
    status: 'open' | 'closed';
    closesAt: string;
    projectIds: string[];
    createdBy: string;
    createdAt: string;
}

export interface NodeConfig {
    serviceRadius?: { lat: number; lng: number; radiusKm: number };
    publishLocation?: boolean;
    publishMembers?: boolean;
    publishContacts?: boolean;
    publishHealth?: boolean;
    directoryPushIntervalHours?: number;
    lastDirectoryPush?: string;
}

const wsClients: Set<any> = new Set();

// ===================== INIT =====================

export function initStateEngine(): void {
    initSchema();
    migrateLegacyState();
    
    // Seed SYSTEM user securely bypassing foreign key constraints
    db.pragma('foreign_keys = OFF');
    try {
        db.prepare("INSERT OR IGNORE INTO members (public_key, callsign, invited_by, invite_code) VALUES ('SYSTEM', 'System', 'genesis', 'genesis')").run();
    } finally {
        db.pragma('foreign_keys = ON');
    }

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

    // CRITICAL: Restore persisted commons balance from DB
    // Without this, COMMONS_BALANCE resets to 0 on every restart, destroying accumulated demurrage
    const commonsRow = db.prepare("SELECT balance FROM accounts WHERE public_key = 'COMMONS_POOL'").get() as any;
    if (commonsRow && commonsRow.balance > 0) {
        setCommonsBalance(commonsRow.balance);
        console.log(`🏛️ Restored Commons Pool balance: ${commonsRow.balance.toFixed(2)}`);
    } else {
        // Seed the COMMONS_POOL account if it doesn't exist
        db.prepare("INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES ('COMMONS_POOL', 0, 0)").run();
        console.log(`🏛️ Commons Pool account seeded (starting from 0)`);
    }

    // Start periodic persistence of commons balance + demurrage ledger rows (every 5 minutes)
    setInterval(() => {
        try { persistDecayEvents(); } catch (e) { console.warn('[Ledger] Failed to persist decay events:', e); }
        persistCommonsBalance();
    }, 5 * 60 * 1000);

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
    }

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

            CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
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
        const requesterPubkey = post && post.type !== 'offer' ? row.seller_pubkey : row.buyer_pubkey;
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
}

function sweepSettledEscrowAccounts(): void {
    const result = db.prepare(`
        DELETE FROM accounts 
        WHERE public_key LIKE 'escrow_%' 
          AND balance = 0
          AND SUBSTR(public_key, 8) NOT IN (
              SELECT id FROM marketplace_transactions WHERE status IN ('pending', 'requested')
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

// A2-20: the /ws feed is global — every connected member receives every broadcast.
// For privacy-sensitive events (a ledger transfer reveals who paid whom + amounts),
// pass `recipients` so the event is delivered ONLY to sockets whose authenticated
// member is a party. Scoping requires per-socket identity, which exists only under
// ENFORCE_WS_AUTH (anonymous sockets are rejected at upgrade); when a socket has no
// identity (flag off) we fall back to the prior broadcast-to-all behavior. General
// community events (new_post, member_joined, profile_updated) pass no recipients and
// stay global, as intended.
export function broadcast(event: any, recipients?: string[]): void {
    const msg = JSON.stringify(event);
    for (const ws of wsClients) {
        if (recipients && ws._memberPubkey && !recipients.includes(ws._memberPubkey)) continue;
        try { ws.send(msg); } catch { wsClients.delete(ws); }
    }
}

// ===================== DB HELPERS =====================

export function assertMemberActive(publicKey: string): void {
    if (publicKey.startsWith('escrow_') || publicKey.startsWith('project_') || publicKey === 'COMMONS_POOL' || publicKey === 'SYSTEM' || publicKey === 'genesis') return;
    const member = db.prepare("SELECT status FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member) throw new Error('Member not found');
    if (member.status === 'disabled') throw new Error('Account is disabled');
    if (member.status === 'pruned') throw new Error('Account has been pruned');
}

export function assertProfileComplete(publicKey: string): void {
    const member = db.prepare("SELECT avatar_url, callsign FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member) return; // Let assertMemberActive handle missing members
    if (!member.avatar_url) {
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

export function redeemInvite(code: string, publicKey: string, callsign: string): { success: boolean; error?: string; member?: Member; alreadyMember?: boolean } {
    return redeemInviteEngine(broadcast, code, publicKey, callsign);
}

export function redeemOfflineTicket(ticketB64: string, joinerPublicKey: string, callsign: string): { success: boolean; error?: string; member?: Member; alreadyMember?: boolean } {
    return redeemOfflineTicketEngine(broadcast, ticketB64, joinerPublicKey, callsign);
}

export function checkInvite(codeOrTicket: string): InviteCheckResult {
    return checkInviteEngine(db, codeOrTicket);
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

export function getProfiles(): Record<string, MemberProfile> {
    return getProfilesEngine(db);
}

export function getAllProfiles(requesterPubkey?: string): MemberProfile[] {
    return getAllProfilesEngine(db, requesterPubkey);
}

export function updateProfile(publicKey: string, update: any): MemberProfile | null {
    return updateProfileEngine(broadcast, publicKey, update);
}

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
        if (s.wardsCount > 0) reasons.push(`${s.wardsCount} ${s.wardsCount === 1 ? 'person trusts' : 'people trust'} them as a recovery guardian.`);
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

export interface ViewerTrustProfile {
    publicKey: string;
    callsign: string;
    joinedAt: string | null;
    lastActiveAt: string | null;
    tier: TierInfo;
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
export function getTrustProfileForViewer(viewerPubkey: string, targetPubkey: string): ViewerTrustProfile | null {
    const member = getMember(targetPubkey);
    if (!member) return null;

    const { stats, tier } = getMemberTrustProfile(targetPubkey);

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

    // Deep-trust signal: how many people made the target their recovery guardian.
    const wardsCount = getMyWards(targetPubkey).length;

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
        `).all(viewerPubkey, targetPubkey, viewerPubkey, targetPubkey) as any[])
            .map(r => ({ publicKey: r.publicKey, callsign: r.callsign, avatarUrl: r.avatarUrl || null }))
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
    let vouchedInBy: ViewerTrustProfile['vouchedInBy'] = null;
    const inviterKey = member.invitedBy;
    if (inviterKey && inviterKey !== targetPubkey) {
        const adminKey = getAdminPubkey();
        if (inviterKey === 'genesis') {
            vouchedInBy = { kind: 'founder', publicKey: null, callsign: null, avatarUrl: null, tier: null };
        } else if (inviterKey === 'SYSTEM' || inviterKey === adminKey) {
            vouchedInBy = { kind: 'admin', publicKey: null, callsign: null, avatarUrl: null, tier: null };
        } else {
            const inviter = getMember(inviterKey);
            if (inviter) {
                vouchedInBy = {
                    kind: 'member',
                    publicKey: inviterKey,
                    callsign: inviter.callsign,
                    avatarUrl: inviter.avatarUrl || null,
                    tier: getMemberTrustProfile(inviterKey).tier.name,
                };
            }
        }
    }

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
                avatarUrl: voucher.avatarUrl || null,
            };
        }
    }

    return {
        publicKey: targetPubkey,
        callsign: member.callsign,
        joinedAt: member.joinedAt || null,
        lastActiveAt: member.lastActiveAt || null,
        tier,
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

export function getBalance(publicKey: string): { balance: number; floor: number; usableFloor: number; liveOffers: number; frozen: boolean; tier: TierInfo; earnedCredit: number; commonsBalance: number; activated: boolean; canVouch: boolean } {
    const account = ledger.getAccount(publicKey);
    const { floor, tier, earnedCredit, activated } = getMemberTrustProfile(publicKey);
    const balance = Math.round(account.balance * 100) / 100;
    const liveOffers = liveOfferCount(publicKey);
    // usableFloor: the deepest you may actually spend right now (Trust Model v3) — the shallower of
    // your earned limit and what your live Offers unlock. frozen: your debt sits below that line.
    const uFloor = Math.max(floor, -offerCapForCount(liveOffers));
    return {
        balance,
        floor,
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


export function transfer(from: string, to: string, amount: number, memo: string, method?: 'direct' | 'escrow', isFeeExempt = false, auth?: { signer: string; signature: string; payload: string }): Transaction | null {
    if (from !== 'genesis' && from !== 'COMMONS_POOL') assertMemberActive(from);
    if (amount < 0) return null;
    // Only register real members — skip synthetic wallets (escrow_*, project_*, etc.) and COMMONS_POOL
    if (!from.startsWith('escrow_') && !from.startsWith('project_') && from !== 'COMMONS_POOL' && !getMember(from)) registerVisitor(from);
    if (!to.startsWith('escrow_') && !to.startsWith('project_') && to !== 'COMMONS_POOL' && !getMember(to)) registerVisitor(to);

    // Send gate (Trust Model v2): direct peer-to-peer sends ("gift a friend") require the sender
    // to have EARNED trust — i.e. completed at least one real (marketplace) trade. Stops a fresh /
    // farmed account from instantly forwarding received credits and vanishing. Re-keyed off the
    // now-cosmetic tier (canGift) onto value-based earned credit. Escrow/marketplace flows and
    // system accounts (COMMONS_POOL/genesis) are exempt.
    const isEscrow = method === 'escrow' || from.startsWith('escrow_') || to.startsWith('escrow_');
    if (!isEscrow && from !== 'COMMONS_POOL' && from !== 'genesis') {
        const { earnedCredit } = getMemberTrustProfile(from);
        if (earnedCredit <= 0) {
            console.log(`🚫 Send blocked (no completed trade yet): ${from.substring(0, 12)}`);
            return null;
        }
    }

    // (Ghost velocity gate removed — the sliding value-based floor already bounds how much a new
    // account can move, so a daily rate-limit keyed off the now-cosmetic "Newcomer" tier is moot.)

    // Sender's spending limit:
    //  • System wallets (escrow_*, COMMONS_POOL, genesis) — unbounded.
    //  • Marketplace / escrow spends — the full earned credit LINE (your floor, may be negative):
    //    the overdraft exists so you can trade for real goods/services, backed by a promise to reciprocate.
    //  • Direct "send credits" gifts — POSITIVE BALANCE ONLY (floor 0). You can only gift beans you
    //    actually hold; you can never go into debt to give beans away.
    const isSystemFrom = from.startsWith('escrow_') || from === 'COMMONS_POOL' || from === 'genesis';
    const senderFloor = isSystemFrom ? -Infinity
        : isEscrow ? usableFloor(from)   // v3: marketplace spends bounded by the offer-banded floor
        : 0;
    // Fee policy: the 1.5% community fee applies ONLY to marketplace/escrow settlements. Direct
    // peer "send credits" gifts are fee-free — gifting a friend beans you hold shouldn't be taxed.
    // System moves (escrow holds, refunds, admin) stay exempt via the caller's isFeeExempt.
    const feeExempt = isFeeExempt || !isEscrow;
    const success = ledger.transfer(from, to, amount, senderFloor, feeExempt);
    if (!success) return null;

    if (!from.startsWith('escrow_') && !from.startsWith('project_') && from !== 'COMMONS_POOL' && from !== 'genesis') {
        recordActivity(from);
    }

    const taxFee = feeExempt ? 0 : amount * TRANSACTION_FEE_RATE;

    const txn: Transaction = {
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
            txn.id, txn.from, txn.to, txn.amount, txn.taxFee, txn.memo, txn.timestamp,
            auth?.signer ?? null, auth?.signature ?? null, auth?.payload ?? null,
        );
    }

    // Sync ledger account balances to DB
    const fromAcc = ledger.getAccount(from);
    const toAcc = ledger.getAccount(to);
    db.prepare(`UPDATE accounts SET balance=?, last_demurrage_epoch=?, last_updated_at=? WHERE public_key=?`).run(fromAcc.balance, fromAcc.lastDemurrageEpoch, new Date().toISOString(), from);
    db.prepare(`UPDATE accounts SET balance=?, last_demurrage_epoch=?, last_updated_at=? WHERE public_key=?`).run(toAcc.balance, toAcc.lastDemurrageEpoch, new Date().toISOString(), to);

    // Persist demurrage decay rows + commons balance (transfers trigger decay on both accounts)
    persistDecayEvents();
    persistCommonsBalance();

    const fromMember = getMember(from);
    const toMember = getMember(to);
    broadcast({
        type: 'transaction',
        txn: { ...txn, fromCallsign: fromMember?.callsign || 'Unknown', toCallsign: toMember?.callsign || 'Unknown' },
    }, [from, to]); // A2-20: a transfer is visible only to its two parties on the live feed
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

function rowToPost(row: any, photosByPost: Map<string, any[]>): MarketplacePost {
    const postPhotos = photosByPost.get(row.id) || [];
    let trustPoints = 0;
    try {
        const trustProfile = getMemberTrustProfile(row.author_pubkey);
        trustPoints = trustProfile.earnedCredit;
    } catch (e) {
        trustPoints = row.author_energy_cycled ?? 0;
    }

    return {
        id: row.id,
        type: row.type,
        category: row.category,
        title: row.title,
        description: row.description,
        credits: row.credits,
        priceType: row.price_type || 'fixed',
        authorPublicKey: row.author_pubkey,
        authorCallsign: row.author_callsign,
        createdAt: row.created_at,
        updatedAt: row.updated_at || row.created_at,
        active: Boolean(row.active),
        status: row.status,
        repeatable: Boolean(row.repeatable),
        acceptedBy: row.accepted_by,
        acceptedByCallsign: row.accepted_callsign,
        acceptedAt: row.accepted_at,
        pendingTransactionId: row.pending_transaction_id,
        completedAt: row.completed_at,
        lat: row.lat,
        lng: row.lng,
        // Version the URL with the photo's updated_at so it can be cached immutably: the URL only
        // changes when the photo actually changes (edit → tombstone/re-insert bumps updated_at),
        // so clients cache forever yet never show a stale image.
        photos: postPhotos.sort((a: any, b: any) => a.order_num - b.order_num).map((p: any) => `/api/marketplace/posts/${row.id}/photos/${p.order_num}?v=${p.updated_at ? new Date(p.updated_at).getTime() : 0}`),
        originNode: row.origin_node,
        authorEnergyCycled: trustPoints,
        authorFoundingNeeded: (row.author_trade_count ?? 0) === 0 && (row.author_earned_credit ?? 0) === 0,
        authorAvatarUrl: row.author_avatar ?? null
    };
}

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
    if (publicKey === getAdminPubkey()) return true;
    return hasListedOfferEngine(db, publicKey);
}

export function hasLiveOffer(publicKey: string): boolean {
    if (publicKey === getAdminPubkey()) return true;
    return hasLiveOfferEngine(db, publicKey);
}

export function liveOfferCount(publicKey: string): number {
    if (publicKey === getAdminPubkey()) return OFFER_BANDS.length - 1;
    return liveOfferCountEngine(db, publicKey);
}

export function usableFloor(publicKey: string): number {
    const { floor } = getMemberTrustProfile(publicKey);
    return Math.max(floor, -offerCapForCount(liveOfferCount(publicKey)));
}

/**
 * Does this member hold the vouch capability (the "appointed voucher" / super-Elder)?
 * Handing out the -20 credit floor is the one Sybil-critical power, so it is NOT derived
 * from Elder *tier* (an earned cosmetic badge — grinding to Elder must not confer the power
 * to mint floors for a sock army). It is an explicit, admin-granted flag (members.can_vouch,
 * set via adminSetVoucher), plus the system admin who always holds it.
 */
export function canVouch(publicKey: string): boolean {
    if (publicKey === getAdminPubkey()) return true;
    const row = db.prepare("SELECT can_vouch FROM members WHERE public_key = ?").get(publicKey) as any;
    return !!row?.can_vouch;
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
    if (!getMember(voucherPubkey)) throw new Error('Voucher not found');
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
    const isAdmin = actorPubkey === getAdminPubkey();
    if (!isAdmin && actorPubkey !== vouchedBy) throw new Error('Only the voucher who vouched, or an admin, can withdraw a vouch');
    if (!isAdmin && getBalance(targetPubkey).balance < 0) {
        throw new Error('Cannot withdraw: this member is still carrying a negative balance. They must return to 0 first.');
    }
    db.prepare(`UPDATE members SET elder_vouched_by = NULL, vouch_credit = 0 WHERE public_key = ?`).run(targetPubkey);
    broadcast({ type: 'profile_updated', publicKey: targetPubkey });
    return { ok: true };
}

export function createPost(
    type: 'offer' | 'need', category: string, title: string, description: string, credits: number,
    priceType: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly' | string, authorPublicKey: string, lat?: number, lng?: number, photos?: string[], repeatable?: boolean, id?: string
): MarketplacePost | null {
    return createPostEngine(broadcast, type, category, title, description, credits, priceType, authorPublicKey, lat, lng, photos, repeatable, id);
}

export function getPosts(filter?: PostFilter): MarketplacePost[] {
    return getPostsEngine(db, filter);
}

export function removePost(id: string, authorPublicKey: string): boolean {
    return removePostEngine(broadcast, id, authorPublicKey);
}

export function updatePost(id: string, authorPublicKey: string, updates: Partial<MarketplacePost>): MarketplacePost | null {
    return updatePostEngine(broadcast, id, authorPublicKey, updates);
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
        SystemMessageType
    };
}

export function requestPost(postId: string, requesterPublicKey: string, hours?: number): MarketplaceTransaction {
    return requestPostEngine(getEscrowCb(), postId, requesterPublicKey, hours);
}

export function approvePostRequest(transactionId: string, authorPublicKey: string): MarketplaceTransaction | null {
    return approvePostRequestEngine(getEscrowCb(), transactionId, authorPublicKey);
}

export function rejectPostRequest(transactionId: string, authorPublicKey: string): MarketplaceTransaction | null {
    return rejectPostRequestEngine(getEscrowCb(), transactionId, authorPublicKey);
}

export function cancelPostRequest(transactionId: string, requesterPublicKey: string): MarketplaceTransaction | null {
    return cancelPostRequestEngine(getEscrowCb(), transactionId, requesterPublicKey);
}

export function acceptPost(postId: string, buyerPublicKey: string, hours?: number): MarketplaceTransaction {
    return acceptPostEngine(getEscrowCb(), postId, buyerPublicKey, hours);
}

export function completePostTransaction(transactionId: string, confirmerPublicKey: string, finalHours?: number): MarketplaceTransaction & { alreadyCompleted?: boolean } | null {
    return completePostTransactionEngine(getEscrowCb(), transactionId, confirmerPublicKey, finalHours);
}

export function cancelPostTransaction(transactionId: string, cancellerPublicKey: string): MarketplaceTransaction | null {
    return cancelPostTransactionEngine(getEscrowCb(), transactionId, cancellerPublicKey);
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

export function getCommunityInfo(publicKey?: string): { memberCount: number; postCount: number; transactionCount: number; commonsBalance: number; currency: { type: string, value: string } } {
    const memberCount = (db.prepare("SELECT COUNT(*) as c FROM members WHERE status != 'pruned'").get() as any).c;
    const postCount = getActivePostCount();
    let txCount = 0;
    if (publicKey) {
        txCount = (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE from_pubkey = ? OR to_pubkey = ?").get(publicKey, publicKey) as any).c;
    } else {
        txCount = (db.prepare("SELECT COUNT(*) as c FROM transactions").get() as any).c;
    }
    const config = getLocalConfig();
    return { memberCount, postCount, transactionCount: txCount, commonsBalance: Math.round(COMMONS_BALANCE * 100) / 100, currency: { type: config.currencyType || 'image', value: config.currencyValue || 'bean' } };
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

export function createConversation(type: 'dm' | 'group', participants: string[], createdBy: string, name?: string, postId?: string): Conversation | null {
    return createConversationEngine(getMessagingCb(), type, participants, createdBy, name, postId);
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

export function ensureTransactionConversation(postId: string, buyerPubkey: string, sellerPubkey: string): string {
    return ensureTransactionConversationEngine(getMessagingCb(), postId, buyerPubkey, sellerPubkey);
}

export function migrateConsolidateConversations(): void {
    return migrateConsolidateConversationsEngine(getMessagingCb());
}

export function repairConsolidatedMessagesMetadata(): void {
    return repairConsolidatedMessagesMetadataEngine();
}

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
    SyncPayload,
    ImportResult,
    NodeRole
};

export { getNodeRole, setNodeRole, getSyncCursor, setSyncCursor, recordSyncAttempt, getCurrentImportOrigin };

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

export function importRemoteState(remote: SyncPayload): Promise<ImportResult> {
    return importRemoteStateEngine(getSyncCb(), remote);
}
// ===================== RATINGS =====================

export { addRating, addFriend, removeFriend, setGuardian };

export function getRatings(targetPubkey: string): any[] {
    return getRatingsEngine(db, targetPubkey);
}

export function getRatingsGiven(raterPubkey: string): Rating[] {
    return getRatingsGivenEngine(db, raterPubkey);
}

export function getAverageRating(targetPubkey: string) {
    return getAverageRatingEngine(db, targetPubkey);
}

// ===================== FRIENDS & GUARDIANS =====================

export function getFriends(pubkey: string): FriendEntry[] {
    return getFriendsEngine(db, pubkey);
}

// ===================== SOCIAL RECOVERY =====================

export function getGuardiansOf(pubkey: string): string[] {
    const rows = db.prepare(`SELECT friend_pubkey FROM friends WHERE owner_pubkey=? AND is_guardian=1`).all(pubkey) as any[];
    return rows.map(r => r.friend_pubkey);
}

export function getMyWards(guardianPubkey: string): { publicKey: string; callsign: string; avatarUrl: string | null }[] {
    const rows = db.prepare(`
        SELECT f.owner_pubkey as publicKey, m.callsign, m.avatar_url as avatarUrl
        FROM friends f 
        JOIN members m ON f.owner_pubkey = m.public_key 
        WHERE f.friend_pubkey=? AND f.is_guardian=1
    `).all(guardianPubkey) as any[];
    return rows;
}

export function createRecoveryRequest(oldPubkey: string, newPubkey: string, guardianGuessCallsign: string): RecoveryRequest | null {
    const oldMember = getMember(oldPubkey);
    if (!oldMember || oldMember.status === 'migrated') throw new Error('Invalid or already migrated member');
    
    // Guardian knowledge check
    const guardians = getGuardiansOf(oldPubkey);
    if (guardians.length < 3) throw new Error('Account does not have enough guardians to recover');
    
    const normalizedGuess = guardianGuessCallsign.toLowerCase().trim();
    const guessMatch = guardians.some(pubkey => {
        const m = getMember(pubkey);
        return m ? m.callsign.toLowerCase().trim() === normalizedGuess : false;
    });
    
    if (!guessMatch) {
        throw new Error('Guardian knowledge check failed. You must provide the exact callsign of one of your guardians.');
    }

    const existingPending = db.prepare(`SELECT * FROM recovery_requests WHERE old_pubkey=? AND status='pending'`).get(oldPubkey);
    if (existingPending) throw new Error('A recovery request is already pending for this account');
    
    if (getMember(newPubkey)) throw new Error('New public key is already registered');

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    
    // Expire in 24 hours (forces active coordination and prevents stale requests)
    const expiresAtDate = new Date();
    expiresAtDate.setHours(expiresAtDate.getHours() + 24);
    const expiresAt = expiresAtDate.toISOString();

    db.prepare(`
        INSERT INTO recovery_requests (id, old_pubkey, new_pubkey, status, quorum_required, created_at, expires_at)
        VALUES (?, ?, ?, 'pending', 3, ?, ?)
    `).run(id, oldPubkey, newPubkey, createdAt, expiresAt);

    return getRecoveryRequest(id)!;
}

export function getRecoveryRequest(id: string): RecoveryRequest | undefined {
    const row = db.prepare(`SELECT * FROM recovery_requests WHERE id=?`).get(id) as any;
    if (!row) return undefined;
    return {
        id: row.id,
        oldPubkey: row.old_pubkey,
        newPubkey: row.new_pubkey,
        status: row.status,
        quorumRequired: row.quorum_required,
        createdAt: row.created_at,
        cooldownUntil: row.cooldown_until,
        executedAt: row.executed_at,
        expiresAt: row.expires_at
    };
}

export function approveRecovery(requestId: string, guardianPubkey: string): boolean {
    const req = getRecoveryRequest(requestId);
    if (!req || req.status !== 'pending') throw new Error('Invalid or non-pending request');
    
    const guardians = getGuardiansOf(req.oldPubkey);
    if (!guardians.includes(guardianPubkey)) throw new Error('Not a guardian for this account');

    db.transaction(() => {
        db.prepare(`INSERT OR REPLACE INTO recovery_approvals (request_id, guardian_pubkey, decision, created_at) VALUES (?, ?, 'approve', ?)`).run(requestId, guardianPubkey, new Date().toISOString());
        
        // Check quorum
        const approvals = db.prepare(`SELECT COUNT(*) as count FROM recovery_approvals WHERE request_id=? AND decision='approve'`).get(requestId) as any;
        if (approvals.count >= req.quorumRequired) {
            const cooldownDate = new Date();
            cooldownDate.setHours(cooldownDate.getHours() + 24);
            db.prepare(`UPDATE recovery_requests SET status='approved', cooldown_until=? WHERE id=?`).run(cooldownDate.toISOString(), requestId);
        }
    })();
    return true;
}

export function rejectRecovery(requestId: string, guardianPubkey: string): boolean {
    const req = getRecoveryRequest(requestId);
    if (!req || req.status !== 'pending') throw new Error('Invalid or non-pending request');
    
    const guardians = getGuardiansOf(req.oldPubkey);
    if (!guardians.includes(guardianPubkey)) throw new Error('Not a guardian for this account');

    db.transaction(() => {
        db.prepare(`INSERT OR REPLACE INTO recovery_approvals (request_id, guardian_pubkey, decision, created_at) VALUES (?, ?, 'reject', ?)`).run(requestId, guardianPubkey, new Date().toISOString());
        
        // Check if impossible to reach quorum
        const rejections = db.prepare(`SELECT COUNT(*) as count FROM recovery_approvals WHERE request_id=? AND decision='reject'`).get(requestId) as any;
        const maxPossibleApprovals = guardians.length - rejections.count;
        if (maxPossibleApprovals < req.quorumRequired) {
            db.prepare(`UPDATE recovery_requests SET status='cancelled' WHERE id=?`).run(requestId);
        }
    })();
    return true;
}

export function cancelRecovery(requestId: string, cancellerPubkey: string): boolean {
    const req = getRecoveryRequest(requestId);
    if (!req || (req.status !== 'pending' && req.status !== 'approved')) throw new Error('Cannot cancel this request');
    
    if (req.oldPubkey !== cancellerPubkey && req.newPubkey !== cancellerPubkey) {
        throw new Error('Only the original or new identity can cancel');
    }

    db.prepare(`UPDATE recovery_requests SET status='cancelled' WHERE id=?`).run(requestId);
    return true;
}

export function executeRecovery(requestId: string): boolean {
    const req = getRecoveryRequest(requestId);
    if (!req || req.status !== 'approved') throw new Error('Request not ready for execution');
    if (!req.cooldownUntil || new Date() < new Date(req.cooldownUntil)) throw new Error('Cooldown period has not elapsed');

    const oldP = req.oldPubkey;
    const newP = req.newPubkey;

    db.transaction(() => {
        // 1. Members and Accounts
        db.prepare(`UPDATE members SET public_key=? WHERE public_key=?`).run(newP, oldP);
        db.prepare(`UPDATE accounts SET public_key=? WHERE public_key=?`).run(newP, oldP);
        
        // 2. Transactions
        db.prepare(`UPDATE transactions SET from_pubkey=? WHERE from_pubkey=?`).run(newP, oldP);
        db.prepare(`UPDATE transactions SET to_pubkey=? WHERE to_pubkey=?`).run(newP, oldP);
        
        // 3. Posts & Marketplace
        db.prepare(`UPDATE posts SET author_pubkey=? WHERE author_pubkey=?`).run(newP, oldP);
        db.prepare(`UPDATE posts SET accepted_by=? WHERE accepted_by=?`).run(newP, oldP);
        db.prepare(`UPDATE marketplace_transactions SET buyer_pubkey=? WHERE buyer_pubkey=?`).run(newP, oldP);
        db.prepare(`UPDATE marketplace_transactions SET seller_pubkey=? WHERE seller_pubkey=?`).run(newP, oldP);
        
        // 4. Conversations & Messages
        db.prepare(`UPDATE conversations SET created_by=? WHERE created_by=?`).run(newP, oldP);
        db.prepare(`UPDATE conversation_participants SET public_key=? WHERE public_key=?`).run(newP, oldP);
        db.prepare(`UPDATE messages SET author_pubkey=? WHERE author_pubkey=?`).run(newP, oldP);
        
        // 5. Friends
        db.prepare(`UPDATE friends SET owner_pubkey=? WHERE owner_pubkey=?`).run(newP, oldP);
        db.prepare(`UPDATE friends SET friend_pubkey=? WHERE friend_pubkey=?`).run(newP, oldP);
        
        // 6. Ratings & Abuse
        db.prepare(`UPDATE ratings SET target_pubkey=? WHERE target_pubkey=?`).run(newP, oldP);
        db.prepare(`UPDATE ratings SET rater_pubkey=? WHERE rater_pubkey=?`).run(newP, oldP);
        db.prepare(`UPDATE abuse_reports SET reporter_pubkey=? WHERE reporter_pubkey=?`).run(newP, oldP);
        db.prepare(`UPDATE abuse_reports SET target_pubkey=? WHERE target_pubkey=?`).run(newP, oldP);
        
        // 7. Projects
        db.prepare(`UPDATE projects SET creator_pubkey=? WHERE creator_pubkey=?`).run(newP, oldP);
        
        // 8. Push Tokens & Prefs
        db.prepare(`UPDATE push_tokens SET public_key=? WHERE public_key=?`).run(newP, oldP);
        db.prepare(`UPDATE member_preferences SET public_key=? WHERE public_key=?`).run(newP, oldP);

        // 9. Mark old as migrated (already changed above, so wait. If we UPDATE members SET public_key=newP WHERE public_key=oldP, oldP is GONE).
        // Let's create a tombstone for oldP just in case.
        const migratedCallsign = 'migrated_' + oldP.substring(0, 8);
        db.prepare(`INSERT INTO members (public_key, callsign, status) VALUES (?, ?, 'migrated')`).run(oldP, migratedCallsign);

        // 10. Update request status
        db.prepare(`UPDATE recovery_requests SET status='executed', executed_at=? WHERE id=?`).run(new Date().toISOString(), requestId);
    })();
    return true;
}

export function getPendingRecoveryRequests(guardianPubkey: string): any[] {
    const wards = getMyWards(guardianPubkey).map(w => w.publicKey);
    if (wards.length === 0) return [];
    
    const rows = selectInChunks(wards, ph => `
        SELECT r.*, m.callsign as old_callsign, m.avatar_url,
               (SELECT COUNT(*) FROM recovery_approvals WHERE request_id=r.id AND decision='approve') as approvals,
               (SELECT decision FROM recovery_approvals WHERE request_id=r.id AND guardian_pubkey=?) as my_decision
        FROM recovery_requests r
        JOIN members m ON r.old_pubkey = m.public_key
        WHERE r.old_pubkey IN (${ph}) AND r.status IN ('pending', 'approved')
    `, [guardianPubkey]);

    return rows.map(r => ({
        id: r.id,
        oldPubkey: r.old_pubkey,
        newPubkey: r.new_pubkey,
        oldCallsign: r.old_callsign,
        avatarUrl: r.avatar_url,
        status: r.status,
        quorumRequired: r.quorum_required,
        approvals: r.approvals,
        myDecision: r.my_decision,
        createdAt: r.created_at,
        cooldownUntil: r.cooldown_until,
        expiresAt: r.expires_at
    }));
}

export function getRecoveryStatus(pubkey: string): any | null {
    const row = db.prepare(`
        SELECT r.*,
               (SELECT COUNT(*) FROM recovery_approvals WHERE request_id=r.id AND decision='approve') as approvals
        FROM recovery_requests r 
        WHERE (r.old_pubkey=? OR r.new_pubkey=?) AND r.status IN ('pending', 'approved')
        ORDER BY r.created_at DESC LIMIT 1
    `).get(pubkey, pubkey) as any;
    
    if (!row) return null;
    return {
        id: row.id,
        status: row.status,
        approvals: row.approvals,
        quorumRequired: row.quorum_required,
        createdAt: row.created_at,
        cooldownUntil: row.cooldown_until
    };
}

// ===================== ABUSE REPORTS =====================

export function submitReport(reporterPubkey: string, targetPubkey: string, reason: string, targetPostId?: string): AbuseReport | null {
    if (!getMember(reporterPubkey) || reporterPubkey === targetPubkey) return null;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, reporterPubkey, targetPubkey, targetPostId || null, reason.slice(0, 500), createdAt);
    return { id, reporterPubkey, targetPubkey, targetPostId, reason: reason.slice(0, 500), createdAt };
}

export function getReports(): AbuseReport[] {
    const rows = db.prepare(`
        SELECT ar.*, 
               mr.callsign as reporter_callsign, 
               mt.callsign as target_callsign,
               p.title as post_title
        FROM abuse_reports ar
        LEFT JOIN members mr ON ar.reporter_pubkey = mr.public_key
        LEFT JOIN members mt ON ar.target_pubkey = mt.public_key
        LEFT JOIN posts p ON ar.target_post_id = p.id
        ORDER BY ar.created_at DESC
    `).all() as any[];
    return rows.map(r => ({ 
        id: r.id, reporterPubkey: r.reporter_pubkey, targetPubkey: r.target_pubkey, 
        targetPostId: r.target_post_id, reason: r.reason, createdAt: r.created_at,
        status: r.status || 'pending',
        reporterCallsign: r.reporter_callsign || r.reporter_pubkey.substring(0, 8),
        targetCallsign: r.target_callsign || r.target_pubkey.substring(0, 8),
        postTitle: r.post_title || null
    }));
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
    const res = db.prepare("UPDATE abuse_reports SET status = 'reviewed' WHERE id = ?").run(reportId);
    return res.changes > 0;
}

export function actionReport(reportId: string, deletePost: boolean = false): boolean {
    const report = db.prepare("SELECT * FROM abuse_reports WHERE id = ?").get(reportId) as any;
    if (!report) return false;
    
    db.prepare("UPDATE abuse_reports SET status = 'actioned' WHERE id = ?").run(reportId);
    
    if (deletePost && report.target_post_id) {
        adminDeletePost(report.target_post_id);
    }
    return true;
}

export function adminBulkDeletePosts(postIds: string[]): number {
    return adminBulkDeletePostsEngine(broadcast, postIds, transfer);
}

export function getPostCount(filter?: { type?: string; category?: string; status?: string; query?: string }): number {
    return getPostCountEngine(db, filter);
}

// ===================== COMMUNITY HEALTH =====================

export interface HealthFlag { type: 'wash_trading' | 'isolated_branch' | 'inactive_member' | 'invite_spam' | 'sybil_funnel' | 'sybil_ring' | 'aggregate_spike' | 'cohort_velocity' | 'delinquency' | 'watchdog_recovery' | 'watchdog_down'; severity: 'warning' | 'alert' | 'critical'; description: string; members: string[]; }
export interface WatchdogStatus { present: boolean; lastSeenAt: string | null; status: string | null; recoveries: number; lastRecoveryAt: string | null; healthy: boolean; }
export interface CommunityHealth { nodeName: string; version: string; minAppVersion: string; currency: { type: string; value: string }; tree: any; activity: any; flags: HealthFlag[]; reportCount: number; watchdog: WatchdogStatus; }

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
        for (const pairKey of enforcement.flaggedPairs) {
            const [a, b] = pairKey.split('|');
            // Skip if all involved accounts are already credit-frozen by admin
            const frozenCount = (db.prepare("SELECT COUNT(*) as cnt FROM members WHERE public_key IN (?, ?) AND credit_frozen = 1").get(a, b) as any)?.cnt || 0;
            if (frozenCount >= 2) continue;

            const callsignA = (db.prepare("SELECT callsign FROM members WHERE public_key=?").get(a) as any)?.callsign || a.substring(0, 8);
            const callsignB = (db.prepare("SELECT callsign FROM members WHERE public_key=?").get(b) as any)?.callsign || b.substring(0, 8);
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
                    return (db.prepare("SELECT callsign FROM members WHERE public_key=?").get(m) as any)?.callsign || m.substring(0, 8);
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
    try {
        const currentMetricRow = db.prepare(`
            SELECT metric_value FROM system_metrics 
            WHERE metric_key = 'total_negative_balance' 
            ORDER BY timestamp DESC LIMIT 1
        `).get() as any;

        const previousMetricRow = db.prepare(`
            SELECT metric_value FROM system_metrics 
            WHERE metric_key = 'total_negative_balance' 
              AND datetime(timestamp) < datetime('now', '-23 hours')
            ORDER BY timestamp DESC LIMIT 1
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
            ORDER BY timestamp DESC LIMIT 1
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
            ORDER BY timestamp DESC LIMIT 1
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

    const config = getLocalConfig();
    const reportCount = getReportCount();
    
    return {
        nodeName: getDirectoryInfo()?.name || 'Local Discovery',
        version: '1.1.35',
        minAppVersion: '1.0.75',
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

export function getAdminPubkey(): string {
    const row = db.prepare("SELECT public_key FROM members WHERE invited_by = 'genesis' LIMIT 1").get() as any;
    return row ? row.public_key : 'system';
}

export function adminSetUserStatus(publicKey: string, status: 'active' | 'disabled' | 'pruned') {
    db.prepare("UPDATE members SET status=? WHERE public_key=?").run(status, publicKey);
    broadcast({ type: 'profile_updated', publicKey });
}

export function adminSetCreditFrozen(publicKey: string, frozen: boolean) {
    db.prepare("UPDATE members SET credit_frozen=? WHERE public_key=?").run(frozen ? 1 : 0, publicKey);
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

export function adminDeletePost(postId: string) {
    return adminDeletePostEngine(broadcast, postId, transfer);
}

export function adminPruneUser(publicKey: string) {
    db.transaction(() => {
        const account = ledger.getAccount(publicKey);
        const balance = account.balance;

        if (balance < 0) {
            const D = Math.abs(balance);
            transfer('COMMONS_POOL', publicKey, D, `Settle bad debt for pruned user: ${publicKey}`, 'direct', true);
        } else if (balance > 0) {
            transfer(publicKey, 'COMMONS_POOL', balance, `Confiscate credit for pruned user: ${publicKey}`, 'direct', true);
        }

        adminSetUserStatus(publicKey, 'pruned');
        db.prepare("UPDATE posts SET status='cancelled', active=0 WHERE author_pubkey=? AND status IN ('active', 'pending')").run(publicKey);
    })();
    broadcast({ type: 'user_pruned', publicKey });
}

export function adminPruneBranch(rootPublicKey: string) {
    const prunings = new Set<string>();
    function pruneRec(pubkey: string) {
        if (prunings.has(pubkey)) return;
        prunings.add(pubkey);
        adminPruneUser(pubkey);
        const children = db.prepare("SELECT public_key FROM members WHERE invited_by=?").all(pubkey) as any[];
        children.forEach(c => pruneRec(c.public_key));
    }
    pruneRec(rootPublicKey);
}

export function adminBroadcastAnnouncement(title: string, body: string, severity: 'info'|'warning'|'critical') {
    broadcast({ type: 'system_announcement', title, body, severity });

    // Also dispatch as a native push notification to all active members
    try {
        const activeMembers = db.prepare("SELECT public_key FROM members WHERE status != 'disabled' AND status != 'pruned'").all() as { public_key: string }[];
        const targetPubkeys = activeMembers.map(m => m.public_key);
        dispatchPushNotification(targetPubkeys, 'SYSTEM', title, body, { type: 'system_announcement' }, 'marketplace');
    } catch (e: any) {
        console.error('[Push Announcement] Failed to send push notification broadcast:', e.message);
    }
}

export function adminSendMessage(targetPubkey: string, body: string) {
    const adminPubkey = getAdminPubkey();
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
    const config: any = row ? JSON.parse(row.value) : {};

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
        lastDirectoryPush: config.lastDirectoryPush
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
    return next;
}

export function getDirectoryInfo(): any {
    const config = getNodeConfig();
    if (!config.publishLocation && !config.publishMembers && !config.publishContacts && !config.publishHealth) {
        return null;
    }
    
    const localConfig = getLocalConfig();
    const info: any = {
        name: localConfig.callsign || process.env.BEANPOOL_NODE_NAME || process.env.CF_RECORD_NAME || 'BeanPool Node'
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
        if (localConfig.contactEmail) info.contactEmail = localConfig.contactEmail;
        if (localConfig.contactPhone) info.contactPhone = localConfig.contactPhone;
    } else {
        info.contactEmail = null;
        info.contactPhone = null;
    }

    if (config.publishHealth) {
        info.version = '1.0.33';
        info.status = 'online';
    } else {
        info.version = null;
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

    const project: CommunityProject = {
        id: crypto.randomUUID(),
        title: title.trim().slice(0, 100),
        description: description.trim().slice(0, 500),
        proposerPubkey, proposerCallsign: member.callsign,
        requestedAmount: Math.round(requestedAmount * 100) / 100,
        status: 'proposed', votes: [], createdAt: new Date().toISOString()
    };
    
    // For simplicity, we store projects as JSON in node_config (since they are rare)
    // Or normally we'd make a table for them. Let's store in config to avoid more schema migrations for now.
    const projects = getAllProjects();
    projects.push(project);
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('commons_projects', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(projects));
    
    broadcast({ type: 'project_created', project });
    return project;
}

export function updateProject(proposerPubkey: string, projectId: string, title: string, description: string, requestedAmount: number): boolean {
    if (!title.trim() || !Number.isFinite(requestedAmount) || requestedAmount <= 0) return false;
    const projects = getAllProjects();
    const index = projects.findIndex(p => p.id === projectId);
    if (index === -1) return false;
    if (projects[index].proposerPubkey !== proposerPubkey) return false;
    if (projects[index].status !== 'proposed') return false;

    projects[index].title = title.trim().slice(0, 100);
    projects[index].description = description.trim().slice(0, 500);
    projects[index].requestedAmount = Math.round(requestedAmount * 100) / 100;
    
    db.prepare(`UPDATE node_config SET value=? WHERE key='commons_projects'`).run(JSON.stringify(projects));
    broadcast({ type: 'project_updated', project: projects[index] });
    return true;
}

export function deleteProject(proposerPubkey: string, projectId: string): boolean {
    const projects = getAllProjects();
    const index = projects.findIndex(p => p.id === projectId);
    if (index === -1) return false;
    if (projects[index].proposerPubkey !== proposerPubkey) return false;
    if (projects[index].status !== 'proposed') return false;

    projects.splice(index, 1);
    db.prepare(`UPDATE node_config SET value=? WHERE key='commons_projects'`).run(JSON.stringify(projects));
    broadcast({ type: 'project_deleted', projectId });
    return true;
}

export function voteForProject(voterPubkey: string, projectId: string, voteCount: number = 1): { success: boolean; creditsUsed?: number; error?: string } {
    if (!getMember(voterPubkey)) return { success: false, error: 'Not a member' };
    if (voteCount < 1 || !Number.isInteger(voteCount)) return { success: false, error: 'Vote count must be a positive integer' };

    const projects = getAllProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) return { success: false, error: 'Project not found' };

    const activeRound = getActiveRound();
    if (!activeRound || !activeRound.projectIds.includes(projectId)) return { success: false, error: 'No active voting round for this project' };

    // QV: Cost = N²
    const creditCost = voteCount * voteCount;

    // Governance credits = qualified trade value (same basis as earned trust; see getGovernanceCredits)
    const credits = getGovernanceCredits(voterPubkey);
    if (creditCost > credits.availableCredits) {
        return { success: false, error: `Insufficient credits: ${voteCount} votes costs ${creditCost} credits, but you have ${credits.availableCredits.toFixed(0)} available` };
    }

    // Remove any existing votes from this voter in this round (they are re-allocating)
    for (const p of projects) {
        if (activeRound.projectIds.includes(p.id)) {
            p.votes = p.votes.filter(v => v.pubkey !== voterPubkey);
        }
    }
    project.votes.push({ pubkey: voterPubkey, weight: voteCount, creditsUsed: creditCost });
    
    db.prepare(`UPDATE node_config SET value=? WHERE key='commons_projects'`).run(JSON.stringify(projects));
    broadcast({ type: 'vote_cast', projectId, voterPubkey, voteCount, creditCost, totalVotes: project.votes.reduce((sum, v) => sum + (v.weight || 1), 0) });
    return { success: true, creditsUsed: creditCost };
}

/**
 * Returns governance (quadratic-voting) credits for a member.
 *
 * Credits = the SAME qualified trade value that backs earned trust: only COMPLETED
 * marketplace (escrow) trades, attributed to the real counterparty, both sides credited,
 * and diversity-capped per counterparty (A2-26). This deliberately excludes direct
 * "send credits" gifts — previously governance ran on raw outbound transfer volume, which
 * let a member mint voting power by gifting beans to alt accounts (Sybil funnel), even
 * though those gifts build no trust. Aligning the two closes that gap: you cannot buy a
 * louder vote with anything you couldn't also turn into trust. Used credits are the sum of
 * all QV costs (voteCount²) in the active round.
 */
export function getGovernanceCredits(pubkey: string): { totalCredits: number; usedCredits: number; availableCredits: number } {
    const totalCredits = Math.round(qualifiedTradeValue(pubkey) * 100) / 100;

    // Used credits = sum of creditsUsed in the active voting round
    let usedCredits = 0;
    const activeRound = getActiveRound();
    if (activeRound) {
        const projects = getAllProjects();
        for (const p of projects) {
            if (activeRound.projectIds.includes(p.id)) {
                for (const v of p.votes) {
                    if (v.pubkey === pubkey) {
                        usedCredits += v.creditsUsed || (v.weight * v.weight) || 1;
                    }
                }
            }
        }
    }

    return { totalCredits, usedCredits, availableCredits: Math.max(0, totalCredits - usedCredits) };
}

export function createVotingRound(adminPubkey: string, projectIds: string[], closesAt: string): VotingRound | null {
    const admin = getMember(adminPubkey);
    if (!admin || (admin.invitedBy !== 'genesis' && admin.invitedBy !== null && admin.invitedBy !== undefined) || getActiveRound()) return null;

    const projects = getAllProjects();
    for (const pid of projectIds) {
        const p = projects.find(pr => pr.id === pid && pr.status === 'proposed');
        if (p) p.status = 'active';
    }
    db.prepare(`UPDATE node_config SET value=? WHERE key='commons_projects'`).run(JSON.stringify(projects));

    const round: VotingRound = { id: crypto.randomUUID(), status: 'open', closesAt, projectIds, createdBy: adminPubkey, createdAt: new Date().toISOString() };
    const rounds = getVotingRounds();
    rounds.push(round);
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('voting_rounds', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(rounds));
    
    broadcast({ type: 'voting_round_created', round });
    return round;
}

export function closeVotingRound(roundId: string): { success: boolean; winner?: CommunityProject; error?: string } {
    const rounds = getVotingRounds();
    const round = rounds.find(r => r.id === roundId && r.status === 'open');
    if (!round) return { success: false, error: 'Round not closed/found' };

    round.status = 'closed';
    db.prepare(`UPDATE node_config SET value=? WHERE key='voting_rounds'`).run(JSON.stringify(rounds));

    // A2-5: rank by total QUADRATIC-VOTE WEIGHT, not raw voter count. The previous
    // `votes.length` sort let a project with many cheap single-credit votes beat a
    // project the community funded more strongly, and treated a lone self-vote the
    // same as broad support.
    const voteWeight = (p: CommunityProject) => p.votes.reduce((s, v) => s + (Number.isFinite(v.weight) ? v.weight : 0), 0);
    const projects = getAllProjects();
    const candidates = projects.filter(p => round.projectIds.includes(p.id)).sort((a, b) => voteWeight(b) - voteWeight(a));
    const winner = candidates[0];

    if (winner && voteWeight(winner) > 0) {
        // A2-5: the commons→proposer grant was previously credited to the proposer's
        // IN-MEMORY ledger account only — no DB write, no transaction row. A crash
        // before the proposer's next transfer lost the grant; with no txn row the
        // ledger could never reconcile to balances, and the conservation audit
        // drifted. Perform it atomically: debit commons, credit the proposer in
        // memory AND in the DB, and record a COMMONS_POOL→proposer transaction — so
        // the grant is durable, auditable, and conservation-consistent.
        if (ledger.deductFromCommons(winner.requestedAmount)) {
            const account = ledger.getAccount(winner.proposerPubkey);
            account.balance += winner.requestedAmount;
            winner.status = 'funded';
            winner.fundedAt = new Date().toISOString();
            const ts = new Date().toISOString();
            const txId = crypto.randomUUID();
            db.transaction(() => {
                db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)
                            ON CONFLICT(public_key) DO UPDATE SET balance=excluded.balance, last_updated_at=?`)
                    .run(winner.proposerPubkey, account.balance, ts);
                db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp) VALUES (?, ?, ?, ?, ?, ?)`)
                    .run(txId, 'COMMONS_POOL', winner.proposerPubkey, winner.requestedAmount, `Commons grant: ${winner.title.slice(0, 80)}`, ts);
            })();
            persistCommonsBalance(); // flush the debited COMMONS_BALANCE to the COMMONS_POOL row
        } else {
            winner.status = 'proposed';
        }
    }

    for (const c of candidates) if (c.id !== winner?.id && c.status === 'active') c.status = 'proposed';
    db.prepare(`UPDATE node_config SET value=? WHERE key='commons_projects'`).run(JSON.stringify(projects));

    broadcast({ type: 'voting_round_closed', roundId, winnerId: winner?.status === 'funded' ? winner.id : null });
    return { success: true, winner: winner?.status === 'funded' ? winner : undefined };
}

export function adminRejectProject(projectId: string): boolean {
    const projects = getAllProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) return false;
    project.status = 'rejected';
    db.prepare(`UPDATE node_config SET value=? WHERE key='commons_projects'`).run(JSON.stringify(projects));
    return true;
}

export function getProjects(): CommunityProject[] {
    return getAllProjects().filter(p => p.status !== 'rejected');
}

export function getAllProjects(): CommunityProject[] {
    const row = db.prepare("SELECT value FROM node_config WHERE key='commons_projects'").get() as any;
    return row ? JSON.parse(row.value) : [];
}

export function getVotingRounds(): VotingRound[] {
    const row = db.prepare("SELECT value FROM node_config WHERE key='voting_rounds'").get() as any;
    return row ? JSON.parse(row.value) : [];
}

export function getActiveRound(): VotingRound | null {
    const round = getVotingRounds().find(r => r.status === 'open');
    if (!round) return null;

    // Lazy auto-close: if past deadline, close and return null.
    // No background timer needed — any read of the active round triggers closure if overdue.
    if (round.closesAt && new Date(round.closesAt).getTime() <= Date.now()) {
        closeVotingRound(round.id);
        return null;
    }
    return round;
}

export function getCommonsBalance(): number {
    return Math.round(COMMONS_BALANCE * 100) / 100;
}

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
 * (boot path / operator script) can decide whether to proceed. Wired at boot
 * when PROMOTED_FROM_BACKUP=true (see index.ts).
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
 */
export function clearReplicatedTables(): void {
    const tables = [
        'members', 'posts', 'post_photos', 'projects', 'ratings', 'accounts',
        'transactions', 'marketplace_transactions', 'friends', 'conversations',
        'conversation_participants', 'messages', 'abuse_reports',
        'recovery_requests', 'recovery_approvals', 'tombstones',
    ];
    db.transaction(() => {
        for (const t of tables) {
            try { db.prepare(`DELETE FROM ${t}`).run(); }
            catch (e) { console.warn(`[Resync] could not clear ${t}:`, e); }
        }
    })();
    console.log('🧹 [Resync] Cleared replicated tables — awaiting fresh snapshot import.');
}

// ===================== PUSH NOTIFICATIONS =====================

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

export function getMemberPreferences(publicKey: string): Record<string, string> {
    const rows = db.prepare(`SELECT pref_key, pref_value FROM member_preferences WHERE public_key = ?`).all(publicKey) as any[];
    const prefs: Record<string, string> = {
        notify_chat: 'true',
        notify_marketplace: 'true',
        notify_escrow: 'true',
    };
    for (const r of rows) prefs[r.pref_key] = r.pref_value;
    return prefs;
}

export function setMemberPreferences(publicKey: string, preferences: Record<string, boolean>): boolean {
    try {
        const stmt = db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?)`);
        const tx = db.transaction(() => {
            for (const [key, value] of Object.entries(preferences)) {
                stmt.run(publicKey, key, String(value));
            }
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
    if (!getMember(publicKey)) throw new Error('Member not found');
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
 * Fire-and-forget pattern.
 */
export function dispatchPushNotification(
    targetPubkeys: string[],
    actorPubkey: string,
    title: string,
    body: string,
    data: Record<string, any>,
    categoryId: 'chat' | 'marketplace' | 'escrow'
): void {
    // Filter out the actor and SYSTEM from targets
    const recipients = targetPubkeys.filter(pk => pk !== actorPubkey && pk !== 'SYSTEM');
    if (recipients.length === 0) return;

    const prefKey = `notify_${categoryId}`;
    
    // Map categoryId to Android channelId
    const channelMap: Record<string, string> = {
        chat: 'chat',
        marketplace: 'marketplace',
        escrow: 'escrow',
    };

    // Map categoryId to notification sound
    const soundMap: Record<string, string> = {
        chat: 'default',      // Softer sound for chat (uses system default for now)
        marketplace: 'default',
        escrow: 'default',
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

        // Calculate total unread count for badge
        const unreadCounts = getUnreadCounts(pk);
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

    if (allMessages.length === 0) return;

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
    const actorName = actorMember?.callsign || meta.actorPubkey?.slice(0, 8) || 'Someone';

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
