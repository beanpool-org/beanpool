import crypto from 'node:crypto';
import { LedgerManager, COMMONS_BALANCE, setCommonsBalance, earnedCreditFromValue, getTier, getGenesisEarnedCredit, vouchCreditForLevel, grantedCreditForTier, offerCapForCount, offersRequiredForDepth, OFFER_BANDS, PROTOCOL_CONSTANTS, TRANSACTION_FEE_RATE } from '@beanpool/core';
import type { TrustStats, TierInfo, GenesisInviteType, VouchLevel, TierName } from '@beanpool/core';
import { getThresholds, getLocalConfig } from './local-config.js';
import { db, initSchema, migrateLegacyState, writeTombstone, setBalanceMutationHook } from './db/db.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPrivateKey } from './p2p.js';
import { publicKeyToProtobuf, publicKeyFromProtobuf } from '@libp2p/crypto/keys';

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
    const text = `${title} ${description}`.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const words = text.split(/\s+/).filter(w => w.length > 2);
    const expanded = new Set<string>();
    expanded.add(category);

    // Try exact match first, then strip common suffixes (lemons→lemon, mowing→mow)
    const lookup = (word: string): string[] | undefined => {
        if (synonymMap[word]) return synonymMap[word];
        if (word.endsWith('ies')) { const stem = word.slice(0, -3) + 'y'; if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('es')) { const stem = word.slice(0, -2); if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('s')) { const stem = word.slice(0, -1); if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('ing')) { const stem = word.slice(0, -3); if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('ed')) { const stem = word.slice(0, -2); if (synonymMap[stem]) return synonymMap[stem]; }
        return undefined;
    };

    for (const word of words) {
        const syns = lookup(word);
        if (syns) {
            for (const syn of syns) expanded.add(syn);
        }
    }
    // Also check multi-word phrases (up to 3 words)
    const allWords = text.split(/\s+/);
    for (let i = 0; i < allWords.length - 1; i++) {
        const two = `${allWords[i]} ${allWords[i+1]}`;
        if (synonymMap[two]) {
            for (const syn of synonymMap[two]) expanded.add(syn);
        }
        if (i < allWords.length - 2) {
            const three = `${allWords[i]} ${allWords[i+1]} ${allWords[i+2]}`;
            if (synonymMap[three]) {
                for (const syn of synonymMap[three]) expanded.add(syn);
            }
        }
    }
    return [...expanded].join(' ');
}

// ===================== TYPES =====================

export interface Member {
    publicKey: string;
    callsign: string;
    joinedAt: string;
    invitedBy: string;
    inviteCode: string;
    homeNodeUrl?: string;
    avatarUrl?: string | null;
    status?: 'active' | 'migrated' | 'pruned' | 'flagged' | string;
    profileUpdatedAt?: number | null;
    bio?: string | null;
    contactValue?: string | null;
    contactVisibility?: string | null;
    lastActiveAt?: string | null;
    /** Source-of-truth mutation watermark used by delta sync for last-writer-wins conflict resolution. */
    updatedAt?: string | null;
    earnedCredit?: number;
    /** Elder who endorsed this member. For a founding member this also lifts the no-overdraft floor-gate. */
    elderVouchedBy?: string | null;
}

export interface InviteCode {
    code: string;
    createdBy: string;
    createdAt: string;
    usedBy: string | null;
    usedAt: string | null;
    intendedFor?: string;
}

export interface MarketplacePost {
    id: string;
    type: 'offer' | 'need';
    category: string;
    title: string;
    description: string;
    credits: number;
    priceType: 'fixed' | 'hourly';
    authorPublicKey: string;
    authorCallsign: string;
    createdAt: string;
    updatedAt?: string;
    active: boolean;
    status: 'active' | 'pending' | 'paused' | 'completed' | 'cancelled';
    repeatable: boolean;
    acceptedBy?: string;
    acceptedByCallsign?: string;
    acceptedAt?: string;
    pendingTransactionId?: string;
    completedAt?: string;
    lat?: number;
    lng?: number;
    photos?: string[];
    originNode?: string;
    authorEnergyCycled?: number;
    authorFoundingNeeded?: boolean; // true = author has no completed trades yet (their first trade unlocks their floor)
    authorAvatarUrl?: string | null;
}

export interface MarketplaceTransaction {
    id: string;
    postId: string;
    postTitle: string;
    buyerPublicKey: string;
    buyerCallsign: string;
    sellerPublicKey: string;
    sellerCallsign: string;
    credits: number;
    hours?: number;
    status: 'requested' | 'pending' | 'completed' | 'cancelled' | 'rejected';
    createdAt: string;
    completedAt?: string;
}

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

export interface MemberProfile {
    publicKey: string;
    avatar: string | null;
    bio: string;
    contact: {
        value: string;
        visibility: 'hidden' | 'trade_partners' | 'community' | 'friends';
    } | null;
    callsign?: string;
    lastActiveAt?: string;
    status?: 'active' | 'disabled' | 'pruned';
    joinedAt?: string;
    elderVouchedBy?: string | null;
    elderVouchedByCallsign?: string | null;
}

export interface Conversation {
    id: string;
    type: 'dm' | 'group';
    postId?: string;
    postTitle?: string;
    postStatus?: string;
    postPhoto?: string | null;
    lastMsgType?: string;
    lastSysType?: string;
    name: string | null;
    participants: string[];
    peerCallsign?: string;
    peerAvatar?: string | null;
    createdBy: string;
    createdAt: string;
}

export interface Message {
    id: string;
    conversationId: string;
    authorPubkey: string;
    ciphertext: string;
    nonce: string;
    type?: 'text' | 'system' | 'image';
    systemType?: SystemMessageType;
    metadata?: string;
    timestamp: string;
    editedAt?: string | null;
}

export enum SystemMessageType {
    ESCROW_CREATED = 'ESCROW_CREATED',
    ESCROW_FUNDED = 'ESCROW_FUNDED',
    ESCROW_RELEASED = 'ESCROW_RELEASED',
    ESCROW_CANCELLED = 'ESCROW_CANCELLED',
    DISPUTE_OPENED = 'DISPUTE_OPENED',
    REVIEW_LEFT = 'REVIEW_LEFT'
}

export interface SystemMessageMetadata {
    amount?: number;        // The Beans involved
    postId: string;         // Link back to the original post
    actorPubkey: string;    // Who triggered the event (Buyer/Seller)
    txHash?: string;        // The ledger transaction ID for verification
    buyerPubkey?: string;
    sellerPubkey?: string;
}

export interface Rating {
    id: string;
    targetPubkey: string;
    raterPubkey: string;
    stars: number;
    comment: string;
    role: 'provider' | 'receiver';
    transactionId: string;
    createdAt: string;
    target_callsign?: string;
    target_avatar?: string | null;
}

export interface AbuseReport {
    id: string;
    reporterPubkey: string;
    targetPubkey: string;
    targetPostId?: string;
    reason: string;
    createdAt: string;
}

export interface FriendEntry {
    publicKey: string;
    callsign: string;
    addedAt: string;
    isGuardian: boolean;
}

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

// ===================== STATE =====================

const ledger = new LedgerManager();
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

    // Marketplace hygiene: expire stale requests, nudge lingering escrows (hourly + once at boot)
    setTimeout(() => {
        try { runMarketplaceHygiene(); } catch (e) { console.warn('[Marketplace] Hygiene sweep failed:', e); }
    }, 60 * 1000);
    setInterval(() => {
        try { runMarketplaceHygiene(); } catch (e) { console.warn('[Marketplace] Hygiene sweep failed:', e); }
    }, 60 * 60 * 1000);

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
function broadcast(event: any, recipients?: string[]): void {
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

function rowToMember(row: any): Member {
    if (!row) return row;
    return {
        publicKey: row.public_key,
        callsign: row.callsign,
        joinedAt: row.joined_at,
        invitedBy: row.invited_by,
        inviteCode: row.invite_code,
        homeNodeUrl: row.home_node_url,
        avatarUrl: row.avatar_url || null,
        profileUpdatedAt: row.profile_updated_at || null,
        bio: row.bio || null,
        contactValue: row.contact_value || null,
        contactVisibility: row.contact_visibility || null,
        status: row.status || 'active',
        lastActiveAt: row.last_active_at || null,
        updatedAt: row.updated_at || null,
        earnedCredit: row.earned_credit ?? 0,
        elderVouchedBy: row.elder_vouched_by || null,
    };
}

function rowToProfile(row: any): MemberProfile {
    if (!row) return row;
    return {
        publicKey: row.public_key,
        avatar: row.avatar_url,
        bio: row.bio || '',
        contact: row.contact_value ? { value: row.contact_value, visibility: row.contact_visibility } : null,
        status: row.status,
        lastActiveAt: row.last_active_at,
        callsign: row.callsign,
        joinedAt: row.joined_at
    };
}

// ===================== MEMBERS =====================

export function seedGenesisMember(adminPublicKey: string, callsign: string): Member {
    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(adminPublicKey) as any;
    if (existing) {
        db.prepare("UPDATE members SET invited_by = 'genesis', invite_code = 'genesis' WHERE public_key = ?").run(adminPublicKey);
        return getMember(adminPublicKey)!;
    }
    // Genesis bootstrap: temporarily disable FK checks because invited_by='genesis'
    // violates the self-referencing FK (no member with public_key='genesis' exists).
    db.pragma('foreign_keys = OFF');
    try {
        db.transaction(() => {
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) 
                        VALUES (?, ?, ?, ?, ?)`).run(adminPublicKey, callsign, new Date().toISOString(), 'genesis', 'genesis');
            db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(adminPublicKey);
        })();
    } finally {
        db.pragma('foreign_keys = ON');
    }
    ledger.initializeGenesisAccount(adminPublicKey);
    console.log(`⛰️ Genesis member seeded: ${callsign}`);
    return getMember(adminPublicKey)!;
}

function registerMemberInternal(publicKey: string, callsign: string, invitedBy: string | null, inviteCode: string | null): Member | null {
    // Callsign validation: require 2+ non-whitespace characters
    if (!callsign || callsign.trim().length < 2) {
        console.warn(`[Security] Rejected registration with invalid callsign "${callsign}" for ${publicKey}`);
        return null;
    }
    callsign = callsign.trim();

    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    if (existing) {
        db.prepare("UPDATE members SET callsign = ? WHERE public_key = ?").run(callsign, publicKey);
        broadcast({ type: 'profile_updated', publicKey });
        return getMember(publicKey)!;
    }

    // SECURITY PATCH: Prevent open registration. If they don't exist and don't have an invite, block them.
    if (!inviteCode && !invitedBy) {
        console.warn(`[Security] Blocked unauthorized open registration attempt for ${callsign} (${publicKey})`);
        return null;
    }

    db.transaction(() => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) 
                    VALUES (?, ?, ?, ?, ?)`).run(publicKey, callsign, new Date().toISOString(), invitedBy, inviteCode);
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(publicKey);
    })();
    ledger.initializeGenesisAccount(publicKey);
    const member = getMember(publicKey)!;
    broadcast({ type: 'member_joined', member });
    console.log(`👤 New member: ${callsign} invited by ${invitedBy ? invitedBy.substring(0, 12) : 'system'}...`);
    return member;
}

export function registerMember(publicKey: string, callsign: string): Member | null {
    return registerMemberInternal(publicKey, callsign, null, null);
}

export function registerVisitor(publicKey: string, callsign?: string, homeNodeUrl?: string): void {
    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    if (existing) {
        if (callsign && existing.callsign.startsWith('Visitor-')) {
            db.prepare("UPDATE members SET callsign = ? WHERE public_key = ?").run(callsign, publicKey);
        }
        if (homeNodeUrl && !existing.home_node_url) {
            db.prepare("UPDATE members SET home_node_url = ? WHERE public_key = ?").run(homeNodeUrl, publicKey);
        }
        return;
    }
    const generatedCallsign = callsign || `Visitor-${publicKey.substring(0, 8)}`;
    db.transaction(() => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, home_node_url) 
                    VALUES (?, ?, ?, ?, ?, ?)`).run(publicKey, generatedCallsign, new Date().toISOString(), null, null, homeNodeUrl || null);
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(publicKey);
    })();
    ledger.initializeGenesisAccount(publicKey);
    console.log(`🌐 Visitor registered: ${generatedCallsign} (federation${homeNodeUrl ? ` from ${homeNodeUrl}` : ''})`);
}

export function getMembers(): Member[] {
    const rows = db.prepare("SELECT * FROM members WHERE status != 'pruned'").all() as any[];
    return rows.map(rowToMember);
}

export function getAllMembers(): Member[] {
    const rows = db.prepare("SELECT * FROM members").all() as any[];
    return rows.map(rowToMember);
}

export function getMember(publicKey: string): Member | undefined {
    const row = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    return row ? rowToMember(row) : undefined;
}

// ===================== INVITE CODES =====================

function generateShortCode(): string {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = 'INV-';
    for (let i = 0; i < 4; i++) code += chars[crypto.randomInt(chars.length)];
    code += '-';
    for (let i = 0; i < 4; i++) code += chars[crypto.randomInt(chars.length)];
    return code;
}

export function generateInvite(inviterPubkey: string, intendedFor?: string): InviteCode | null {
    if (!getMember(inviterPubkey)) return null;

    // Every member can invite from day one (tiers are recognition badges and
    // gate nothing). The old "Ghost gate" here was a no-op — getTier returns
    // canInvite: true for every tier — and the offline BP- ticket path never
    // had a tier check anyway; removed rather than half-enforced.
    recordActivity(inviterPubkey);

    const code = generateShortCode();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, intended_for) VALUES (?, ?, ?, ?)`).run(code, inviterPubkey, createdAt, intendedFor || null);
    const invite: InviteCode = { code, createdBy: inviterPubkey, createdAt, usedBy: null, usedAt: null, intendedFor };
    const inviter = getMember(inviterPubkey);
    console.log(`🎟️  Invite generated: ${code} by ${inviter?.callsign || inviterPubkey.substring(0, 12)}`);
    return invite;
}

/**
 * Admin-only invite generation — bypasses Ghost tier gate and supports tiered genesis invites.
 * The genesis type is stored on the invite code and applied during redemption.
 */
export function adminGenerateInvite(adminPubkey: string, genesisType: GenesisInviteType = 'standard', intendedFor?: string): InviteCode | null {
    if (!getMember(adminPubkey)) return null;
    recordActivity(adminPubkey);

    const code = generateShortCode();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, intended_for, genesis_type) VALUES (?, ?, ?, ?, ?)`).run(code, adminPubkey, createdAt, intendedFor || null, genesisType);
    const invite: InviteCode = { code, createdBy: adminPubkey, createdAt, usedBy: null, usedAt: null, intendedFor };
    const tierLabel = genesisType === 'standard' ? '🥚' : genesisType === 'trusted' ? '🏠' : genesisType === 'ambassador' ? '🏛️' : '⛰️';
    console.log(`🎟️  Admin Genesis Invite generated: ${code} [${genesisType} ${tierLabel}] by ${getMember(adminPubkey)?.callsign || adminPubkey.substring(0, 12)}`);
    return invite;
}

export function redeemInvite(code: string, publicKey: string, callsign: string): { success: boolean; error?: string; member?: Member } {
    const invite = db.prepare("SELECT * FROM invite_codes WHERE code COLLATE NOCASE = ?").get(code) as any;
    if (!invite) return { success: false, error: 'Invalid invite code' };
    if (invite.used_by) return { success: false, error: 'This invite has already been used' };

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const createdAtTime = new Date(invite.created_at).getTime();
    if (Date.now() - createdAtTime > SEVEN_DAYS_MS) {
        return { success: false, error: 'This invite code has expired (maximum 7 days validation)' };
    }

    if (getMember(publicKey)) return { success: false, error: 'You are already a member' };

    // Register member FIRST — invite_codes.used_by has FK to members(public_key)
    const member = registerMemberInternal(publicKey, callsign, invite.created_by, code);
    if (!member) return { success: false, error: 'Registration failed' };

    db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code COLLATE NOCASE = ?").run(publicKey, new Date().toISOString(), code);

    // Pre-seed earned credit for tiered genesis invites
    const genesisType = (invite.genesis_type || 'standard') as GenesisInviteType;
    if (genesisType !== 'standard') {
        const earnedCredit = getGenesisEarnedCredit(genesisType);
        if (earnedCredit > 0) {
            db.prepare("UPDATE members SET earned_credit = ? WHERE public_key = ?").run(earnedCredit, publicKey);
            const tier = getTier(PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR - earnedCredit);
            console.log(`🌟 Genesis invite redeemed: ${callsign} starts as ${tier.emoji} ${tier.name} (earned_credit: ${earnedCredit})`);
        }
    }

    return { success: true, member };
}

/**
 * Parse + cryptographically verify an offline BP- ticket WITHOUT consuming it.
 * Shared by redeemOfflineTicket (which additionally takes the replay lock and
 * registers the member) and checkInvite (read-only pre-flight for onboarding).
 */
function verifyOfflineTicket(ticketB64: string):
    | { ok: true; inviterPubkey: string; timestamp: number; intendedFor?: string; codeHash: string }
    | { ok: false; reason: 'unknown_inviter' | 'expired' | 'invalid' | 'malformed'; error: string } {
    try {
        // Support both standard base64 and url-safe base64 by normalizing back to standard
        const normalizedB64 = ticketB64.replace(/-/g, '+').replace(/_/g, '/');
        const ticketStr = Buffer.from(normalizedB64, 'base64').toString('utf8');
        const ticketObj = JSON.parse(ticketStr);
        const { p: payloadStr, s: signatureBase64 } = ticketObj;

        // Client format split: the PWA puts the raw JSON payload in `p`; the
        // native app base64-encodes it. Signature verification must run over
        // the exact bytes that were signed (the JSON), so decode base64 first.
        let signedBytes = Buffer.from(payloadStr);
        let payloadJson = payloadStr;
        if (!payloadStr.trim().startsWith('{')) {
            signedBytes = Buffer.from(payloadStr, 'base64');
            payloadJson = signedBytes.toString('utf8');
        }

        const payloadObj = JSON.parse(payloadJson);
        const { i: inviterPubkey, t: timestamp, f: intendedFor } = payloadObj;

        // 1. Verify Inviter exists (Sybil Protection)
        if (!getMember(inviterPubkey)) return { ok: false, reason: 'unknown_inviter', error: 'Inviter is not a formally recognized member of this decentralized mesh' };

        // 2. Strict Time-To-Live expiration (7 Days limit). Future-dated
        // timestamps are rejected too — otherwise a ticket stamped years ahead
        // would never age past the TTL.
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
        const FUTURE_SKEW_MS = 10 * 60 * 1000;
        if (typeof timestamp !== 'number' || timestamp > Date.now() + FUTURE_SKEW_MS) {
            return { ok: false, reason: 'invalid', error: 'Offline ticket timestamp is invalid' };
        }
        if (Date.now() - timestamp > SEVEN_DAYS_MS) {
            return { ok: false, reason: 'expired', error: 'This offline ticket has expired (maximum 7 days issuance)' };
        }

        // 3. Mathematical Cryptographic Validation
        const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
        const spki = Buffer.concat([spkiHeader, Buffer.from(inviterPubkey, 'hex')]);
        const publicKeyObject = crypto.createPublicKey({
            key: spki,
            format: 'der',
            type: 'spki'
        });

        const isValid = crypto.verify(
            undefined,
            signedBytes,
            publicKeyObject,
            Buffer.from(signatureBase64, 'base64')
        );

        if (!isValid) return { ok: false, reason: 'invalid', error: 'Invalid cryptographic signature structure' };

        // 4. One-Time Replay Protection key
        // We hash the signature to map it perfectly matching traditional shortcodes in length (16-char max)
        const codeHash = crypto.createHash('sha256').update(signatureBase64).digest('hex').substring(0, 16);
        return { ok: true, inviterPubkey, timestamp, intendedFor, codeHash };
    } catch (e) {
        return { ok: false, reason: 'malformed', error: 'Malformed or broken offline ticket payload' };
    }
}

export function redeemOfflineTicket(ticketB64: string, joinerPublicKey: string, callsign: string): { success: boolean; error?: string; member?: Member } {
    try {
        const verified = verifyOfflineTicket(ticketB64);
        if (!verified.ok) return { success: false, error: verified.error };
        const { inviterPubkey, timestamp, intendedFor, codeHash } = verified;

        // One-Time Replay Protection Database Matrix
        const existingInvite = db.prepare("SELECT * FROM invite_codes WHERE code COLLATE NOCASE = ?").get(codeHash) as any;
        if (existingInvite) {
            if (existingInvite.used_by) return { success: false, error: 'This exact mathematical offline ticket has already been redeemed' };
        } else {
            // First time ingestion into the mesh matrix - structurally inject to SQLite to lock memory
            const createdAt = new Date(timestamp).toISOString();
            db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, intended_for) VALUES (?, ?, ?, ?)`).run(codeHash, inviterPubkey, createdAt, intendedFor || null);
        }

        // 5. Formal Identity Registration
        if (getMember(joinerPublicKey)) return { success: false, error: 'You are already a participating identity on the mesh' };
        recordActivity(inviterPubkey);

        const member = registerMemberInternal(joinerPublicKey, callsign, inviterPubkey, codeHash);
        if (!member) return { success: false, error: 'Registration failed during state sync' };

        // Update the lock
        db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code COLLATE NOCASE = ?").run(joinerPublicKey, new Date().toISOString(), codeHash);

        return { success: true, member };

    } catch (e) {
        return { success: false, error: 'Malformed or broken offline ticket payload' };
    }
}

export interface InviteCheckResult {
    valid: boolean;
    reason?: 'invalid' | 'used' | 'expired' | 'unknown_inviter' | 'malformed';
    inviterCallsign?: string | null;
}

/**
 * Read-only pre-flight validation of an invite — standard INV- code or offline
 * BP- ticket payload (clients strip the BP- prefix, matching the redeem API).
 * Lets onboarding reject a dud invite at Step 1, before the user has been
 * through the name/photo/seed ceremony. Never consumes or records anything;
 * the inviter's callsign is only revealed for a currently-valid invite.
 */
export function checkInvite(codeOrTicket: string): InviteCheckResult {
    const raw = (codeOrTicket || '').trim();
    if (!raw) return { valid: false, reason: 'invalid' };

    // Offline tickets are long base64url payloads; everything short is a code.
    if (raw.length > 20 && !/^INV-/i.test(raw)) {
        const verified = verifyOfflineTicket(raw);
        if (!verified.ok) return { valid: false, reason: verified.reason };
        const existing = db.prepare("SELECT used_by FROM invite_codes WHERE code COLLATE NOCASE = ?").get(verified.codeHash) as any;
        if (existing?.used_by) return { valid: false, reason: 'used' };
        return { valid: true, inviterCallsign: getMember(verified.inviterPubkey)?.callsign ?? null };
    }

    const invite = db.prepare("SELECT * FROM invite_codes WHERE code COLLATE NOCASE = ?").get(raw) as any;
    if (!invite) return { valid: false, reason: 'invalid' };
    if (invite.used_by) return { valid: false, reason: 'used' };

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - new Date(invite.created_at).getTime() > SEVEN_DAYS_MS) {
        return { valid: false, reason: 'expired' };
    }

    return { valid: true, inviterCallsign: getMember(invite.created_by)?.callsign ?? null };
}

export function getInvitesByMember(pubkey: string): InviteCode[] {
    const rows = db.prepare("SELECT * FROM invite_codes WHERE created_by = ?").all(pubkey) as any[];
    return rows.map(r => ({
        code: r.code, createdBy: r.created_by, createdAt: r.created_at, usedBy: r.used_by, usedAt: r.used_at, intendedFor: r.intended_for
    }));
}

export interface InviteTreeNode {
    publicKey: string;
    callsign: string;
    joinedAt: string;
    inviteCode: string;
    children: InviteTreeNode[];
}

export function getInviteTree(rootPubkey?: string): InviteTreeNode[] {
    const allMembers = getAllMembers();

    // ⚡ Bolt: Group members by invitedBy to avoid O(N²) nested filtering, turning it to O(N) lookup.
    const membersByInviter = new Map<string, Member[]>();
    for (const m of allMembers) {
        if (m.invitedBy && m.publicKey !== m.invitedBy) {
            if (!membersByInviter.has(m.invitedBy)) {
                membersByInviter.set(m.invitedBy, []);
            }
            membersByInviter.get(m.invitedBy)!.push(m);
        }
    }

    function buildSubtree(parentPubkey: string): InviteTreeNode[] {
        const children = membersByInviter.get(parentPubkey) || [];
        return children
            .map(m => ({
                publicKey: m.publicKey, callsign: m.callsign, joinedAt: m.joinedAt, inviteCode: m.inviteCode,
                children: buildSubtree(m.publicKey),
            }));
    }

    if (rootPubkey) {
        return buildSubtree(rootPubkey);
    }

    const genesisRoots = allMembers.filter(m => (m.invitedBy === 'genesis' || m.publicKey === 'genesis') && m.publicKey !== 'SYSTEM' && !m.publicKey.startsWith('escrow_'));
    if (genesisRoots.length === 0) {
        // Restored DB fallback: treat members with null/missing invitedBy as root(s)
        const roots = allMembers.filter(m => (!m.invitedBy || m.invitedBy === 'system') && m.publicKey !== 'SYSTEM' && !m.publicKey.startsWith('escrow_'));
        if (roots.length > 0) {
            return roots.map(m => ({
                publicKey: m.publicKey, callsign: m.callsign, joinedAt: m.joinedAt, inviteCode: m.inviteCode || '',
                children: buildSubtree(m.publicKey),
            }));
        }
    }
    return genesisRoots.map(m => ({
        publicKey: m.publicKey, callsign: m.callsign, joinedAt: m.joinedAt, inviteCode: m.inviteCode || '',
        children: buildSubtree(m.publicKey),
    }));
}

// ===================== PROFILES =====================

export function updateProfile(publicKey: string, update: {
    avatar?: string | null;
    bio?: string;
    contact?: { value: string; visibility: 'hidden' | 'trade_partners' | 'community' | 'friends' } | null;
    callsign?: string;
}): MemberProfile | null {
    if (!getMember(publicKey)) return null;
    recordActivity(publicKey);
    
    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    const avatar = update.avatar !== undefined ? update.avatar : existing.avatar_url;
    const bio = typeof update.bio === 'string' ? update.bio.slice(0, 200) : (update.bio === null ? null : existing.bio);
    const callsign = typeof update.callsign === 'string' ? update.callsign.slice(0, 32) : existing.callsign;
    let contact_value = existing.contact_value;
    let contact_visibility = existing.contact_visibility;
    if (update.contact !== undefined) {
        contact_value = update.contact?.value || null;
        contact_visibility = update.contact?.visibility || null;
    }

    const profileUpdatedAt = new Date().toISOString();

    db.prepare(`UPDATE members SET avatar_url=?, bio=?, contact_value=?, contact_visibility=?, callsign=?, profile_updated_at=? WHERE public_key=?`)
      .run(avatar, bio, contact_value, contact_visibility, callsign, profileUpdatedAt, publicKey);
      
    broadcast({ type: 'profile_updated', publicKey, profileUpdatedAt });
    return getProfile(publicKey);
}

export function getProfile(publicKey: string, requesterPubkey?: string): MemberProfile | null {
    const row = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!row) return null;
    const profile = rowToProfile(row);
    profile.elderVouchedBy = row.elder_vouched_by || null;
    if (row.elder_vouched_by) {
        const voucher = db.prepare("SELECT callsign FROM members WHERE public_key = ?").get(row.elder_vouched_by) as any;
        profile.elderVouchedByCallsign = voucher?.callsign || null;
    }
    if (profile.contact && profile.contact.visibility === 'hidden' && requesterPubkey !== publicKey) {
        profile.contact = null;
    } else if (profile.contact && profile.contact.visibility === 'friends' && requesterPubkey !== publicKey) {
        if (!requesterPubkey) {
            profile.contact = null;
        } else {
            const isFriend = db.prepare("SELECT 1 FROM friends WHERE owner_pubkey=? AND friend_pubkey=?").get(publicKey, requesterPubkey);
            if (!isFriend) profile.contact = null;
        }
    }
    return profile;
}

export function getProfiles(): Record<string, MemberProfile> {
    const rows = db.prepare("SELECT * FROM members WHERE status != 'pruned'").all() as any[];
    const map: Record<string, MemberProfile> = {};
    for (const row of rows) {
        const p = rowToProfile(row);
        if (p.contact && p.contact.visibility !== 'community') p.contact = null;
        map[p.publicKey] = p;
    }
    return map;
}

export function getAllProfiles(requesterPubkey?: string): MemberProfile[] {
    const rows = db.prepare("SELECT * FROM members WHERE status != 'pruned'").all() as any[];
    
    // Batch fetch friends where friend_pubkey is the requesterPubkey
    let friendOwners = new Set<string>();
    if (requesterPubkey) {
        const friendRows = db.prepare("SELECT owner_pubkey FROM friends WHERE friend_pubkey = ?").all(requesterPubkey) as any[];
        friendOwners = new Set(friendRows.map(f => f.owner_pubkey));
    }

    const profiles: MemberProfile[] = [];
    for (const row of rows) {
        const profile = rowToProfile(row);
        const publicKey = profile.publicKey;
        if (profile.contact && requesterPubkey !== publicKey) {
            if (profile.contact.visibility === 'hidden') {
                profile.contact = null;
            } else if (profile.contact.visibility === 'friends') {
                if (!requesterPubkey || !friendOwners.has(publicKey)) {
                    profile.contact = null;
                }
            }
        }
        profiles.push(profile);
    }
    return profiles;
}

// ===================== TRUST STATS =====================

/**
 * Calculates trust metrics for a member used by the dynamic credit formula.
 * Excludes escrow system wallets and self-transactions.
 */
export function getMemberTrustStats(publicKey: string): TrustStats {
    const member = getMember(publicKey);
    if (!member) return { tradeCount: 0, uniquePartners: 0, ageDays: 0 };

    // Trade count: completed transactions (direct and marketplace completed)
    const tradeCountRow = db.prepare(`
        SELECT (
            SELECT COUNT(*) FROM transactions 
            WHERE (from_pubkey = ? OR to_pubkey = ?) 
            AND from_pubkey != to_pubkey
            AND from_pubkey NOT LIKE 'escrow_%' 
            AND to_pubkey NOT LIKE 'escrow_%'
            AND from_pubkey != 'SYSTEM'
            AND to_pubkey != 'SYSTEM'
        ) + (
            SELECT COUNT(*) FROM marketplace_transactions 
            WHERE (buyer_pubkey = ? OR seller_pubkey = ?) 
            AND status = 'completed'
        ) as count
    `).get(publicKey, publicKey, publicKey, publicKey) as any;

    // Unique trade partners: distinct counterparties (direct and marketplace completed)
    const uniquePartnersRow = db.prepare(`
        SELECT COUNT(DISTINCT partner) as count FROM (
            SELECT to_pubkey as partner FROM transactions 
            WHERE from_pubkey = ? 
            AND to_pubkey NOT LIKE 'escrow_%' 
            AND to_pubkey != 'SYSTEM'
            AND to_pubkey != ?
            UNION
            SELECT from_pubkey as partner FROM transactions 
            WHERE to_pubkey = ? 
            AND from_pubkey NOT LIKE 'escrow_%' 
            AND from_pubkey != 'SYSTEM'
            AND from_pubkey != ?
            UNION
            SELECT seller_pubkey as partner FROM marketplace_transactions
            WHERE buyer_pubkey = ? AND status = 'completed' AND seller_pubkey != ?
            UNION
            SELECT buyer_pubkey as partner FROM marketplace_transactions
            WHERE seller_pubkey = ? AND status = 'completed' AND buyer_pubkey != ?
        )
    `).get(publicKey, publicKey, publicKey, publicKey, publicKey, publicKey, publicKey, publicKey) as any;

    // Account age in days
    const joinedAt = member.joinedAt ? new Date(member.joinedAt) : new Date();
    const ageDays = Math.floor((Date.now() - joinedAt.getTime()) / (1000 * 60 * 60 * 24));

    return {
        tradeCount: tradeCountRow?.count || 0,
        uniquePartners: uniquePartnersRow?.count || 0,
        ageDays: Math.max(0, ageDays),
    };
}

// A2-26: cap how much volume to a SINGLE counterparty counts toward earned credit /
// governance credit, so a Sybil pair can't wash-trade between themselves to inflate
// either (earned credit deepens the overdraft floor; governance credit buys votes).
// Tuning (owner decision 2026-07-05): Lowered cap from 5000 to 500. One solid trade
// banks a partner; repeat trades add nothing. Legitimate users need more distinct
// counterparties to build deep credit.
const PER_COUNTERPARTY_VOLUME_CAP = 500;

export interface WashAnalysis {
    flaggedPairs: Set<string>;
    flaggedClusters: Map<string, number>;
    clusterDetails: {
        members: string[];
        internalVol: number;
        totalVol: number;
        insularity: number;
        newRatio: number;
        size: number;
        newMembers: number;
    }[];
    pairDetails: {
        a: string;
        b: string;
        gross: number;
        r: number;
    }[];
}

let cachedWashAnalysis: WashAnalysis | null = null;
let lastWashAnalysisTime = 0;

export function runWashTradingAnalysis(): WashAnalysis {
    const flaggedPairs = new Set<string>();
    const flaggedClusters = new Map<string, number>();
    const clusterDetails: any[] = [];
    const pairDetails: any[] = [];

    // --- 1. Net-flow ratio (per counterparty pair) ---
    try {
        const rows = db.prepare(`
            SELECT buyer_pubkey, seller_pubkey, SUM(credits) as vol
            FROM marketplace_transactions
            WHERE status = 'completed' AND buyer_pubkey != seller_pubkey
            GROUP BY buyer_pubkey, seller_pubkey
        `).all() as { buyer_pubkey: string; seller_pubkey: string; vol: number }[];

        const pairVolumes = new Map<string, { u: string; v: string; volUtoV: number; volVtoU: number }>();
        for (const row of rows) {
            const u = row.buyer_pubkey;
            const v = row.seller_pubkey;
            const key = u < v ? `${u}|${v}` : `${v}|${u}`;
            let data = pairVolumes.get(key);
            if (!data) {
                data = { u: u < v ? u : v, v: u < v ? v : u, volUtoV: 0, volVtoU: 0 };
                pairVolumes.set(key, data);
            }
            if (row.buyer_pubkey === data.u) {
                data.volUtoV += row.vol;
            } else {
                data.volVtoU += row.vol;
            }
        }

        for (const [key, data] of pairVolumes.entries()) {
            const gross = data.volUtoV + data.volVtoU;
            if (gross >= PER_COUNTERPARTY_VOLUME_CAP) {
                const r = Math.abs(data.volUtoV - data.volVtoU) / gross;
                pairDetails.push({ a: data.u, b: data.v, gross, r });
                if (r < 0.15) {
                    flaggedPairs.add(key);
                }
            }
        }
    } catch (e) {
        console.error('Wash analysis (pair net flow) failed:', e);
    }

    // --- 2. Cluster insularity (connected components over rolling 30 days) ---
    try {
        const txs30 = db.prepare(`
            SELECT buyer_pubkey, seller_pubkey, credits
            FROM marketplace_transactions
            WHERE status = 'completed' AND buyer_pubkey != seller_pubkey
              AND completed_at > datetime('now', '-30 days')
        `).all() as { buyer_pubkey: string; seller_pubkey: string; credits: number }[];

        const adj = new Map<string, Set<string>>();
        const edgeVol30 = new Map<string, number>();
        const nodes30 = new Set<string>();

        for (const tx of txs30) {
            const u = tx.buyer_pubkey;
            const v = tx.seller_pubkey;
            nodes30.add(u);
            nodes30.add(v);

            if (!adj.has(u)) adj.set(u, new Set());
            if (!adj.has(v)) adj.set(v, new Set());
            adj.get(u)!.add(v);
            adj.get(v)!.add(u);

            const key = u < v ? `${u}|${v}` : `${v}|${u}`;
            edgeVol30.set(key, (edgeVol30.get(key) || 0) + tx.credits);
        }

        const visited = new Set<string>();
        const components: string[][] = [];

        for (const node of nodes30) {
            if (visited.has(node)) continue;
            const comp: string[] = [];
            const queue = [node];
            visited.add(node);

            while (queue.length > 0) {
                const curr = queue.shift()!;
                comp.push(curr);
                const neighbors = adj.get(curr) || new Set();
                for (const next of neighbors) {
                    if (!visited.has(next)) {
                        visited.add(next);
                        queue.push(next);
                    }
                }
            }
            components.push(comp);
        }

        if (components.length > 0) {
            const uniqueNodes = Array.from(nodes30);
            const memberAges = new Map<string, number>();
            
            for (let i = 0; i < uniqueNodes.length; i += 999) {
                const chunk = uniqueNodes.slice(i, i + 999);
                const placeholders = chunk.map(() => '?').join(',');
                const membersRows = db.prepare(`
                    SELECT public_key, joined_at FROM members WHERE public_key IN (${placeholders})
                `).all(...chunk) as { public_key: string; joined_at: string }[];

                for (const m of membersRows) {
                    const joined = m.joined_at ? new Date(m.joined_at) : new Date();
                    const ageDays = (Date.now() - joined.getTime()) / (1000 * 60 * 60 * 24);
                    memberAges.set(m.public_key, ageDays);
                }
            }

            let compIdx = 0;
            for (const comp of components) {
                if (comp.length <= 12) {
                    const compSet = new Set(comp);
                    let internalVol = 0;
                    for (const [key, vol] of edgeVol30.entries()) {
                        const [u, v] = key.split('|');
                        if (compSet.has(u) && compSet.has(v)) {
                            internalVol += vol;
                        }
                    }

                    const placeholders = comp.map(() => '?').join(',');
                    let totalVol = 0;
                    try {
                        const allTimeRes = db.prepare(`
                            SELECT COALESCE(SUM(credits), 0) as s FROM marketplace_transactions
                            WHERE status = 'completed' AND (buyer_pubkey IN (${placeholders}) OR seller_pubkey IN (${placeholders}))
                        `).get(...comp, ...comp) as any;
                        totalVol = allTimeRes ? allTimeRes.s : 0;
                    } catch (e) {
                        console.error('Failed to query all-time volume for component:', e);
                        totalVol = internalVol;
                    }

                    const insularity = totalVol > 0 ? (internalVol / totalVol) : 0;
                    let newMembersCount = 0;
                    for (const m of comp) {
                        const age = memberAges.get(m) ?? 0;
                        if (age < 14) {
                            newMembersCount++;
                        }
                    }

                    const newRatio = comp.length > 0 ? (newMembersCount / comp.length) : 0;

                    clusterDetails.push({
                        members: comp,
                        internalVol,
                        totalVol,
                        insularity,
                        newRatio,
                        size: comp.length,
                        newMembers: newMembersCount
                    });

                    if (insularity >= 0.8 && newMembersCount >= comp.length / 2) {
                        for (const m of comp) {
                            flaggedClusters.set(m, compIdx);
                        }
                    }
                    compIdx++;
                }
            }
        }
    } catch (e) {
        console.error('Wash analysis (cluster insularity) failed:', e);
    }

    return { flaggedPairs, flaggedClusters, clusterDetails, pairDetails };
}

export function getWashTradingEnforcement(): WashAnalysis {
    if (cachedWashAnalysis && (Date.now() - lastWashAnalysisTime < 10000)) {
        return cachedWashAnalysis;
    }
    cachedWashAnalysis = runWashTradingAnalysis();
    lastWashAnalysisTime = Date.now();
    return cachedWashAnalysis;
}

export function clearWashTradingCache() {
    cachedWashAnalysis = null;
    lastWashAnalysisTime = 0;
}

/**
 * F3 — value that counts toward EARNED TRUST: only COMPLETED marketplace (escrow) trades.
 *
 * Attributed to the REAL counterparty (buyer↔seller), not the intermediating escrow account,
 * and capped per counterparty (PER_COUNTERPARTY_VOLUME_CAP) so diverse trade counts for more
 * than repeat trade with one partner. BOTH sides of a completed trade earn the value (the seller
 * delivered, the buyer paid). Direct peer-to-peer "send credits" are gifts/helping-a-friend —
 * they are deliberately NOT trades and build NO trust (per product decision, 2026-07).
 *
 * Enforcement (soft haircut — Change 3): Excludes flagged wash-trading pairs and intra-cluster trades
 * for flagged insular clusters from the trust sum.
 */
function qualifiedTradeValue(publicKey: string): number {
    const { flaggedPairs, flaggedClusters } = getWashTradingEnforcement();

    const rows = db.prepare(`
        SELECT counterparty, COALESCE(SUM(credits), 0) as v FROM (
            SELECT seller_pubkey AS counterparty, credits FROM marketplace_transactions
                WHERE buyer_pubkey = ? AND status = 'completed' AND seller_pubkey != ?
            UNION ALL
            SELECT buyer_pubkey AS counterparty, credits FROM marketplace_transactions
                WHERE seller_pubkey = ? AND status = 'completed' AND buyer_pubkey != ?
        ) GROUP BY counterparty
    `).all(publicKey, publicKey, publicKey, publicKey) as { counterparty: string; v: number }[];

    return rows.reduce((sum, r) => {
        const pairKey = publicKey < r.counterparty ? `${publicKey}|${r.counterparty}` : `${r.counterparty}|${publicKey}`;
        // Haircut check:
        // 1. Exclude if pair is flagged as wash trading
        if (flaggedPairs.has(pairKey)) {
            return sum;
        }
        // 2. Exclude if both members are in the same flagged cluster component
        const clusterIdA = flaggedClusters.get(publicKey);
        const clusterIdB = flaggedClusters.get(r.counterparty);
        if (clusterIdA !== undefined && clusterIdA === clusterIdB) {
            return sum;
        }
        return sum + Math.min(r.v, PER_COUNTERPARTY_VOLUME_CAP);
    }, 0);
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
    const stats = getMemberTrustStats(publicKey);

    // GRANTED-credit lane: genesis pre-seed + admin Elder grants (adminSetElder) + Elder vouch.
    // Stored in members.earned_credit (legacy column name). It is a credit-*limit* input only —
    // it mints/moves no beans — and it is kept SEPARATE from the earned score, so grants deepen
    // the floor but never count as "earned" (governance votes use earned/value only, not grants).
    const memberRow = db.prepare("SELECT earned_credit, elder_vouched_by, vouch_credit, COALESCE(credit_frozen, 0) as credit_frozen FROM members WHERE public_key = ?").get(publicKey) as any;
    const grantedCredit = memberRow?.earned_credit || 0;
    const elderVouched = !!memberRow?.elder_vouched_by;
    // The vouch level's credit floor (25/50/100). A vouch recorded before the level system, or
    // with no stored amount, defaults to the light level.
    const vouchCredit = elderVouched ? (memberRow?.vouch_credit > 0 ? memberRow.vouch_credit : PROTOCOL_CONSTANTS.VOUCH_CREDIT_LIGHT) : 0;
    const isCreditFrozen = memberRow?.credit_frozen === 1;

    const c = PROTOCOL_CONSTANTS;

    // EARNED-credit lane (Trust Model v2 / F3): a saturating function of qualified trade VALUE —
    // ONLY completed marketplace (escrow) trades, attributed to the real counterparty and capped
    // per-counterparty (A2-26 diversity), crediting both buyer and seller. Direct "send credits"
    // are gifts, not trades, and build no trust. Earning a deep floor requires real, diverse,
    // completed trade — not gifts or 1-bean pings across sock accounts.
    const value = qualifiedTradeValue(publicKey);
    const rawEarned = earnedCreditFromValue(value);

    // Star rating scales EARNED value only (0.5–1.0×); granted credit passes through intact.
    const ratingsRow = db.prepare(`
        SELECT AVG(stars) as avg, COUNT(*) as cnt
        FROM ratings
        WHERE target_pubkey = ?
    `).get(publicKey) as any;
    const reviewCount = ratingsRow?.cnt || 0;
    const avgRating = ratingsRow?.avg || 5.0;
    const multiplier = reviewCount > 0 ? (0.5 + 0.5 * (avgRating / 5.0)) : 1.0;
    const earnedCredit = Math.max(0, Math.floor(rawEarned * multiplier));

    // Activation gate — a member has NO credit line at all (floor stays at 0; no overdraft) until an
    // appointed voucher vouches for them, or an admin/genesis grant graduates a founding member.
    // Completing a trade NO LONGER activates: that was a Sybil faucet — N sock accounts each doing
    // one throwaway trade with a colluding creator would each mint themselves the -20 voucher (gift
    // 1 bean to N socks → 20N beans of unbacked credit). The -20 floor is now *handed out* by a
    // vouch: the one human-gated, admin-appointed way in (see vouchMember / can_vouch). Nice
    // property — when a member is finally vouched, any earned trust they'd already banked unlocks
    // alongside the welcome voucher, so their floor jumps straight to reflect their real trading.
    // Trust Model v3: a completed real trade (earnedCredit > 0) opens the floor on its own — no
    // vouch required. Restores the documented behaviour (docs/trust-model-shipped.md §1) that the
    // #15 vouch-gating pass dropped, which left earned-trust members showing "no credit line".
    const activated = elderVouched || grantedCredit > 0 || earnedCredit > 0;
    const allowance = (activated && !isCreditFrozen)
        ? Math.min(c.CREDIT_FLOOR_CAP, vouchCredit + earnedCredit + grantedCredit)
        : 0;

    // Floor = -(voucher + earned + granted) once activated, clamped so the deepest floor is
    // -CREDIT_FLOOR_CAP; 0 for an un-vouched member. CREDIT_BASE_FLOOR is 0 — no baked-in overdraft.
    const floor = c.CREDIT_BASE_FLOOR - allowance;

    const tier = getTier(floor);

    // qualifiedValue: raw diversity-capped trade value (drives the native "value traded"
    // achievement + value-to-next-tier estimate). avgRating/reviewCount: the reputation
    // multiplier inputs, surfaced so the client can show them honestly.
    return { stats, floor, tier, earnedCredit, grantedCredit, qualifiedValue: value, avgRating, reviewCount, vouched: elderVouched, activated };
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
export const CONTRIBUTION_REQUIRED_ERROR = 'CONTRIBUTION_REQUIRED: list at least one Offer before you can post Needs or accept Offers.';

// Offer covenant (Gate 2). To spend on community credit — i.e. take (or keep) your balance
// negative — you must have at least one LIVE Offer posted right now. Carrying a negative balance
// means the community is holding credit for you; the covenant is that you keep a line in the
// water so others can call on you to repay it in kind. Stable prefix so clients can detect this
// rejection and show the "post an Offer" prompt rather than a raw error.
export const COVENANT_REQUIRED_ERROR = 'COVENANT_REQUIRED: keep at least one active Offer posted to spend on community credit (a negative balance).';

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
    const row = db.prepare(`SELECT 1 FROM posts WHERE author_pubkey = ? AND type = 'offer' LIMIT 1`).get(publicKey);
    return !!row;
}

/**
 * Does this member have at least one LIVE Offer posted right now? Unlike hasListedOffer
 * ("ever listed one"), this requires a currently-visible Offer (active row, status 'active').
 * Enforces the offer covenant: you may only spend into a negative balance while you keep a
 * line in the water. The system admin is exempt (it acts at the system level).
 */
export function hasLiveOffer(publicKey: string): boolean {
    if (publicKey === getAdminPubkey()) return true;
    const row = db.prepare(`SELECT 1 FROM posts WHERE author_pubkey = ? AND type = 'offer' AND active = 1 AND status = 'active' LIMIT 1`).get(publicKey);
    return !!row;
}

/**
 * Count of a member's currently-LIVE Offers (active row, status 'active'). Drives the banded
 * offer covenant (Trust Model v3): how deep a member may spend on credit scales with this count.
 * Admin is exempt — treated as fully unlocked (max band).
 */
export function liveOfferCount(publicKey: string): number {
    if (publicKey === getAdminPubkey()) return OFFER_BANDS.length - 1;
    const row = db.prepare(`SELECT COUNT(*) AS c FROM posts WHERE author_pubkey = ? AND type = 'offer' AND active = 1 AND status = 'active'`).get(publicKey) as any;
    return row?.c || 0;
}

/**
 * The floor a member may actually USE right now = the shallower of their earned limit and the
 * depth their live Offers unlock. Returns a value in [floor, 0] (0 when they hold no live Offer).
 */
export function usableFloor(publicKey: string): number {
    const { floor } = getMemberTrustProfile(publicKey);        // earned limit (≤ 0)
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
    assertMemberActive(authorPublicKey);
    if (!getMember(authorPublicKey)) {
        return null;
    }
    assertProfileComplete(authorPublicKey);
    assertNotOnHoliday(authorPublicKey);
    validatePostPhotos(photos);

    // Contribution-first gate: listing an Offer is always allowed (it's what
    // clears the gate); posting a Need requires having listed an Offer first.
    if (type === 'need' && !hasListedOffer(authorPublicKey)) throw new Error(CONTRIBUTION_REQUIRED_ERROR);

    const finalId = id || crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const searchKeywords = generateSearchKeywords(title, description, category);
    
    db.transaction(() => {
        db.prepare(`INSERT INTO posts (
            id, type, category, title, description, credits, price_type, author_pubkey, created_at, active, status, repeatable, lat, lng, updated_at, search_keywords
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?)`).run(finalId, type, category, title, description, credits, priceType, authorPublicKey, createdAt, repeatable ? 1 : 0, lat ?? null, lng ?? null, createdAt, searchKeywords);

        if (photos && photos.length > 0) {
            const insertPhoto = db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num) VALUES (?, ?, ?)`);
            photos.slice(0, 5).forEach((p, idx) => insertPhoto.run(finalId, p, idx));
        }
    })();

    const post = getPosts({ id: finalId }).find(p => p.id === finalId)!;
    broadcast({ type: 'new_post', post });
    return post;
}

export function getPosts(filter?: { id?: string; type?: string; category?: string; status?: string; offset?: number; limit?: number; updatedAfter?: string; query?: string; authorPubkey?: string; viewerPubkey?: string; sync?: boolean }): MarketplacePost[] {
    let query = `
        SELECT p.*, m.callsign as author_callsign, m.avatar_url as author_avatar, a.callsign as accepted_callsign,
               COALESCE((SELECT SUM(amount) FROM transactions WHERE from_pubkey = m.public_key), 0) as author_energy_cycled,
               COALESCE(m.earned_credit, 0) as author_earned_credit,
               (
                 COALESCE((SELECT COUNT(*) FROM transactions t
                      WHERE (t.from_pubkey = m.public_key OR t.to_pubkey = m.public_key)
                        AND t.from_pubkey != t.to_pubkey
                        AND t.from_pubkey NOT LIKE 'escrow_%' AND t.to_pubkey NOT LIKE 'escrow_%'
                        AND t.from_pubkey != 'SYSTEM' AND t.to_pubkey != 'SYSTEM'), 0) +
                 COALESCE((SELECT COUNT(*) FROM marketplace_transactions mt
                      WHERE (mt.buyer_pubkey = m.public_key OR mt.seller_pubkey = m.public_key)
                        AND mt.status = 'completed'), 0)
               ) as author_trade_count
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key
        LEFT JOIN members a ON p.accepted_by = a.public_key
        WHERE 1=1
    `;
    const params: any[] = [];

    if (!filter?.id && !filter?.updatedAfter && !filter?.sync) {
        // Regular client paginated fetch: only active/pending — PLUS the author's own paused posts
        // when they're viewing themselves (so they can find & re-activate them). Viewer-aware: paused
        // is included only when the signed requester IS the author, never leaked to profile viewers.
        const selfView = !!filter?.authorPubkey && filter.authorPubkey === filter.viewerPubkey;
        query += selfView
            ? " AND p.active = 1 AND p.status IN ('active', 'pending', 'paused')"
            : " AND p.active = 1 AND p.status IN ('active', 'pending')";
        // Holiday mode: hide away members' posts from the general feed. NOT applied when viewing a
        // specific author's own listings (authorPubkey) or during sync (updatedAfter) — those carry
        // every state so each node can re-apply this read-time filter itself.
        if (!filter?.authorPubkey) {
            query += " AND p.author_pubkey NOT IN (SELECT public_key FROM member_preferences WHERE pref_key='holiday_mode' AND pref_value='true')";
        }
    } else if (filter?.updatedAfter || filter?.sync) {
        // Sync daemon fetch: MUST include completed/cancelled/deleted states to sync deletions
    } else {
        query += " AND p.active = 1";
    }

    if (filter?.id) { query += " AND p.id = ?"; params.push(filter.id); }
    if (filter?.type && filter.type !== 'all') { query += " AND p.type = ?"; params.push(filter.type); }
    if (filter?.category && filter.category !== 'all') { query += " AND p.category = ?"; params.push(filter.category); }
    if (filter?.status) { query += " AND p.status = ?"; params.push(filter.status); }
    if (filter?.authorPubkey) { query += " AND p.author_pubkey = ?"; params.push(filter.authorPubkey); }

    // FTS5 full-text search with synonym-expanded keywords
    if (filter?.query && filter.query.trim()) {
        const searchTerms = filter.query.trim().replace(/["']/g, '').split(/\s+/).filter(w => w.length > 0);
        if (searchTerms.length > 0) {
            const ftsQuery = searchTerms.map(t => `"${t}"*`).join(' OR ');
            query += ` AND p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)`;
            params.push(ftsQuery);
        }
    }

    if (filter?.updatedAfter) {
        query += " AND p.updated_at >= ?";
        params.push(filter.updatedAfter);
    }

    query += " ORDER BY p.updated_at DESC, p.created_at DESC";
    
    if (filter?.limit) {
        query += " LIMIT ? OFFSET ?";
        params.push(filter.limit, filter.offset || 0);
    }

    const rows = db.prepare(query).all(...params) as any[];
    const postIds = rows.map(r => r.id);
    
    // Return URLs for ALL photos of every post — but only the order numbers, never the
    // image bytes. rowToPost maps these to /photos/:orderNum URLs, so the feed stays tiny
    // (a few short strings per post) while the client can render the full set. The actual
    // image data downloads lazily per-photo when each URL is rendered (e.g. post detail
    // carousel), so the data-light feed behaviour is preserved.
    const photos = selectInChunks(postIds, ph => `SELECT post_id, order_num, updated_at FROM post_photos WHERE post_id IN (${ph})`);

    // ⚡ Bolt: Group photos by post_id to avoid O(N²) nested filtering, turning it to O(N) lookup.
    const photosByPost = new Map<string, any[]>();
    for (const p of photos as any[]) {
        if (!photosByPost.has(p.post_id)) {
            photosByPost.set(p.post_id, []);
        }
        photosByPost.get(p.post_id)!.push(p);
    }

    return rows.map(r => rowToPost(r, photosByPost));
}

export function removePost(id: string, authorPublicKey: string): boolean {
    // A post with a funded escrow must not be deletable — that would strand the
    // buyer's Beans with no release path. (Admin deletes handle this by refunding.)
    const pendingTx = db.prepare(`SELECT COUNT(*) as c FROM marketplace_transactions WHERE post_id = ? AND status = 'pending'`).get(id) as any;
    if (pendingTx.c > 0) throw new Error('This post has a deal in escrow — complete or cancel the deal before deleting it');

    let removed = false;
    db.transaction(() => {
        const result = db.prepare(`UPDATE posts SET active = 0, status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND author_pubkey = ?`).run(id, authorPublicKey);
        if (result.changes === 0) return;
        removed = true;
        // Reject open requests so they don't linger against a deleted post (no funds locked yet)
        db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND status='requested'`).run(id);
    })();
    if (!removed) return false;
    broadcast({ type: 'post_removed', id });
    return true;
}

export function updatePost(id: string, authorPublicKey: string, updates: Partial<MarketplacePost>): MarketplacePost | null {
    if (updates.photos !== undefined && Array.isArray(updates.photos)) {
        // Clients send back /api/marketplace/posts/{id}/photos/{n} URLs for photos they
        // kept during an edit (rowToPost serves URLs, never bytes). Re-hydrate those from
        // the stored data — storing the URL string itself would destroy the photo.
        const existingByOrder = new Map<number, string>(
            (db.prepare(`SELECT order_num, photo_data FROM post_photos WHERE post_id=?`).all(id) as any[])
                .map(r => [r.order_num, r.photo_data])
        );
        updates.photos = updates.photos.map(p => {
            const m = typeof p === 'string' ? p.match(/\/api\/marketplace\/posts\/([^/]+)\/photos\/(\d+)(?:\?.*)?$/) : null;
            if (m && m[1] === id) {
                const data = existingByOrder.get(Number(m[2]));
                if (data) return data;
            }
            return p;
        });
        validatePostPhotos(updates.photos);
    }
    const setClauses: string[] = [];
    const params: any[] = [];
    
    if (updates.title) { setClauses.push("title = ?"); params.push(updates.title); }
    if (updates.description !== undefined) { setClauses.push("description = ?"); params.push(updates.description); }
    if (updates.category) { setClauses.push("category = ?"); params.push(updates.category); }
    if (updates.credits !== undefined) { setClauses.push("credits = ?"); params.push(updates.credits); }
    if (updates.priceType) { setClauses.push("price_type = ?"); params.push(updates.priceType); }
    if (updates.type) { setClauses.push("type = ?"); params.push(updates.type); }
    if (updates.lat !== undefined) { setClauses.push("lat = ?"); params.push(updates.lat); }
    if (updates.lng !== undefined) { setClauses.push("lng = ?"); params.push(updates.lng); }
    if (updates.repeatable !== undefined) { setClauses.push("repeatable = ?"); params.push(updates.repeatable ? 1 : 0); }
    
    if (setClauses.length === 0 && updates.photos === undefined) return getPosts({ id })[0];

    // Regenerate search keywords if title, description, or category changed
    if (updates.title || updates.description !== undefined || updates.category) {
        const existing = db.prepare(`SELECT title, description, category FROM posts WHERE id = ?`).get(id) as any;
        if (existing) {
            const newTitle = updates.title || existing.title;
            const newDesc = updates.description !== undefined ? updates.description : existing.description;
            const newCat = updates.category || existing.category;
            const keywords = generateSearchKeywords(newTitle, newDesc, newCat);
            setClauses.push("search_keywords = ?");
            params.push(keywords);
        }
    }

    setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");

    const query = `UPDATE posts SET ${setClauses.join(', ')} WHERE id = ? AND author_pubkey = ? AND active = 1`;
    params.push(id, authorPublicKey);

    db.transaction(() => {
        if (setClauses.length > 1) { // >1 because updated_at is always added
            db.prepare(query).run(...params);
        }
        if (updates.photos !== undefined) {
            // Tombstone existing photos before deletion so mirrors propagate the
            // removal. Any (post_id, order_num) that gets re-inserted below will
            // win over the tombstone at import time (newer updated_at).
            const existingPhotos = db.prepare(`SELECT order_num FROM post_photos WHERE post_id=?`).all(id) as { order_num: number }[];
            for (const ph of existingPhotos) {
                writeTombstone('post_photos', `${id}|${ph.order_num}`);
            }
            db.prepare(`DELETE FROM post_photos WHERE post_id=?`).run(id);
            const insertPhoto = db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num) VALUES (?, ?, ?)`);
            updates.photos.slice(0, 5).forEach((p, idx) => insertPhoto.run(id, p, idx));
        }
    })();

    const post = getPosts({ id })[0];
    if (!post) return null;
    broadcast({ type: 'post_updated', post });
    return post;
}

// ===================== MARKETPLACE TRANSACTIONS =====================

export function requestPost(postId: string, requesterPublicKey: string, hours?: number): MarketplaceTransaction {
    assertMemberActive(requesterPublicKey);
    assertProfileComplete(requesterPublicKey);
    assertNotOnHoliday(requesterPublicKey);
    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(postId) as any;
    if (!post) throw new Error('Post not found');
    if (post.status !== 'active') throw new Error('Post is not active');
    if (post.author_pubkey === requesterPublicKey) throw new Error('You cannot request your own post');
    if (isOnHoliday(post.author_pubkey)) throw new Error('This member is away (holiday mode) and not trading right now.');

    // One open request per member per post — prevents accidental double-taps and request spam
    const existingRequest = db.prepare(`SELECT id FROM marketplace_transactions WHERE post_id=? AND status='requested' AND (buyer_pubkey=? OR seller_pubkey=?)`)
        .get(postId, requesterPublicKey, requesterPublicKey);
    if (existingRequest) throw new Error('You already have an open request for this post');

    // For Needs, the Author pays. For Offers, the Requester pays.
    const isOffer = post.type === 'offer';
    // Contribution-first gate: requesting an Offer extracts value, so it requires
    // the requester to have listed an Offer of their own. Requesting a Need
    // (offering to fulfil it) is a contribution and is always allowed.
    if (isOffer && !hasListedOffer(requesterPublicKey)) throw new Error(CONTRIBUTION_REQUIRED_ERROR);
    const payerPubkey = isOffer ? requesterPublicKey : post.author_pubkey;
    const payeePubkey = isOffer ? post.author_pubkey : requesterPublicKey;

    // Check if the PAYER has enough balance at the time of request to prevent spam
    const cost = post.price_type !== 'fixed' ? (post.credits * (hours || 1)) : post.credits;
    const { balance, floor, usableFloor: uFloor } = getBalance(payerPubkey);
    if (balance - cost < floor) throw new Error('Insufficient balance to request this post.');
    // Offer covenant (v3): how deep you may spend on credit is gated by your live-Offer count —
    // uFloor already caps the earned floor by the band, so this one check covers "no offer" too.
    if (balance - cost < uFloor) throw floorLockedError(payerPubkey, balance - cost);

    const transactionId = crypto.randomUUID();
    
    db.transaction(() => {
        db.prepare(`
            INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'requested', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        `).run(transactionId, postId, payerPubkey, payeePubkey, cost, hours || null);
    })();

    // Note: getMarketplaceTransactions fetches by user; we'll fetch for the requester
    const tx = getMarketplaceTransaction(transactionId)!;
    broadcast({ type: 'transaction_requested', transaction: tx });

    // Push notification: notify the post author that someone wants their item
    const requesterMember = getMember(requesterPublicKey) as any;
    const requesterName = requesterMember?.callsign || requesterPublicKey.slice(0, 8);
    dispatchPushNotification(
        [post.author_pubkey],
        requesterPublicKey,
        '📬 New Request',
        `${requesterName} wants "${post.title}"`,
        { screen: 'post', postId },
        'marketplace'
    );

    return tx;
}

export function approvePostRequest(transactionId: string, authorPublicKey: string): MarketplaceTransaction | null {
    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='requested'").get(transactionId) as any;
    if (!row) throw new Error('Request not found');

    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(row.post_id) as any;
    if (!post || post.author_pubkey !== authorPublicKey) throw new Error('Only the author can approve a request');

    const isOffer = post.type === 'offer';
    const expectedAuthorRole = isOffer ? row.seller_pubkey : row.buyer_pubkey;
    if (expectedAuthorRole !== authorPublicKey) throw new Error('Unauthorized');

    // A non-repeatable post already committed to another deal (e.g. via 1-step accept)
    // must not be approved into a second escrow — that would double-sell the item.
    if (!post.repeatable && post.status !== 'active') throw new Error('Post is no longer available — it is already committed to another deal');

    // Verify payer STILL has enough money at the exact moment of approval
    const { balance, floor } = getBalance(row.buyer_pubkey);
    if (balance - row.credits < floor) throw new Error('Payer has insufficient funds in their wallet');

    // Create the deal conversation BEFORE locking funds — if conversation creation
    // fails we abort with nothing committed, instead of locking escrow with no
    // chat thread. (Idempotent if it already exists.)
    ensureTransactionConversation(row.post_id, row.buyer_pubkey, row.seller_pubkey);

    db.transaction(() => {
        // Ensure synthetic escrow account exists natively
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(`escrow_${transactionId}`);

        // 1. Lock the funds in Escrow — abort if transfer fails
        // Wallet keyed by transaction ID to isolate concurrent recurring-post transactions
        const escrowResult = transfer(row.buyer_pubkey, `escrow_${transactionId}`, row.credits, `Escrow hold for post ${row.post_id}`, 'escrow', true);
        if (!escrowResult) throw new Error('Failed to lock funds in escrow — insufficient balance or ledger error');
        
        // 2. Mark this transaction as pending
        db.prepare(`UPDATE marketplace_transactions SET status='pending' WHERE id=?`).run(transactionId);
        
        // 3. Mark the Post as pending — the status='active' guard makes the commit
        // conditional, so a post that slipped into another deal aborts the whole escrow
        if (!post.repeatable) {
            const updated = db.prepare(`UPDATE posts SET status='pending', accepted_by=?, accepted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), pending_transaction_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND status='active'`)
              .run(row.seller_pubkey === authorPublicKey ? row.buyer_pubkey : row.seller_pubkey, transactionId, row.post_id);
            if (updated.changes === 0) throw new Error('Post is no longer available — it is already committed to another deal');

            // 4. Reject all other competing requests for this Non-Repeatable post
            db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND id!=? AND status='requested'`)
              .run(row.post_id, transactionId);
        }
    })();

    const tx = getMarketplaceTransaction(transactionId)!;
    broadcast({ type: 'transaction_approved', transaction: tx });
    broadcast({ type: 'post_updated', post: getPosts({ id: row.post_id })[0] });

    // Post-commit side effects must never fail the API call — escrow is already funded.
    try {
        injectSystemMessage(row.post_id, SystemMessageType.ESCROW_FUNDED, {
            amount: row.credits,
            postId: row.post_id,
            actorPubkey: authorPublicKey,
            buyerPubkey: row.buyer_pubkey,
            sellerPubkey: row.seller_pubkey
        }, row.buyer_pubkey, row.seller_pubkey);
    } catch (e) {
        console.warn('[Marketplace] ESCROW_FUNDED system message failed (deal committed):', e);
    }

    // Push notification: notify the requester that their request was approved
    const requesterPubkey = isOffer ? row.buyer_pubkey : row.seller_pubkey;
    dispatchPushNotification(
        [requesterPubkey],
        authorPublicKey,
        '✅ Request Approved',
        `Your request for "${post.title}" was approved!`,
        { screen: 'post', postId: row.post_id },
        'marketplace'
    );

    return tx;
}

export function rejectPostRequest(transactionId: string, authorPublicKey: string): MarketplaceTransaction | null {
    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='requested'").get(transactionId) as any;
    if (!row) return null;

    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(row.post_id) as any;
    if (!post) return null;

    const isOffer = post.type === 'offer';
    const expectedAuthorRole = isOffer ? row.seller_pubkey : row.buyer_pubkey;
    if (expectedAuthorRole !== authorPublicKey) return null;

    db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(transactionId);
    
    const tx = getMarketplaceTransaction(transactionId)!;
    broadcast({ type: 'transaction_rejected', transaction: tx });

    // Push notification: notify the requester that their request was declined
    const requesterPubkey = isOffer ? row.buyer_pubkey : row.seller_pubkey;
    dispatchPushNotification(
        [requesterPubkey],
        authorPublicKey,
        '❌ Request Declined',
        `Your request for "${post.title}" was declined`,
        { screen: 'post', postId: row.post_id },
        'marketplace'
    );

    return tx;
}

export function cancelPostRequest(transactionId: string, requesterPublicKey: string): MarketplaceTransaction | null {
    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='requested'").get(transactionId) as any;
    if (!row) return null;

    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(row.post_id) as any;
    if (!post) return null;

    const isOffer = post.type === 'offer';
    const expectedRequesterRole = isOffer ? row.buyer_pubkey : row.seller_pubkey;
    if (expectedRequesterRole !== requesterPublicKey) return null;

    db.prepare(`UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(transactionId);
    
    const tx = getMarketplaceTransaction(transactionId)!;
    broadcast({ type: 'transaction_cancelled', transaction: tx });
    return tx;
}

export function acceptPost(postId: string, buyerPublicKey: string, hours?: number): MarketplaceTransaction {
    assertMemberActive(buyerPublicKey);
    assertNotOnHoliday(buyerPublicKey);
    const post = getPosts({ id: postId, status: 'active' })[0];
    if (!post) throw new Error('Post not found or not active');
    if (post.authorPublicKey === buyerPublicKey) throw new Error('Cannot accept your own post');
    if (isOnHoliday(post.authorPublicKey)) throw new Error('This member is away (holiday mode) and not trading right now.');

    if (post.type !== 'offer') {
        throw new Error('Only Offers can be 1-step accepted');
    }

    // Contribution-first gate: accepting an Offer extracts value, so the buyer
    // must have listed an Offer of their own first.
    if (!hasListedOffer(buyerPublicKey)) throw new Error(CONTRIBUTION_REQUIRED_ERROR);

    if (post.priceType !== 'fixed' && (typeof hours !== 'number' || hours <= 0)) {
        throw new Error(`Must provide a valid quantity for a ${post.priceType} post`);
    }

    const buyer = getMember(buyerPublicKey);
    const finalCredits = post.priceType !== 'fixed' ? post.credits * hours! : post.credits;

    // Check balance
    const { balance, floor, usableFloor: uFloor } = getBalance(buyerPublicKey);
    if (balance - finalCredits < floor) throw new Error('Insufficient balance to accept this offer');
    // Offer covenant (v3): how deep you may spend on credit is gated by your live-Offer count.
    if (balance - finalCredits < uFloor) throw floorLockedError(buyerPublicKey, balance - finalCredits);

    const tx: MarketplaceTransaction = {
        id: crypto.randomUUID(), postId: post.id, postTitle: post.title, buyerPublicKey,
        buyerCallsign: buyer?.callsign || 'Anonymous', sellerPublicKey: post.authorPublicKey,
        sellerCallsign: post.authorCallsign, credits: finalCredits, hours: post.priceType !== 'fixed' ? hours : undefined,
        status: 'pending', createdAt: new Date().toISOString(),
    };

    // Create the deal conversation BEFORE locking funds — if conversation creation
    // fails we abort with nothing committed, instead of locking escrow with no
    // chat thread and no way to notify either party. (Idempotent if it exists.)
    ensureTransactionConversation(post.id, buyerPublicKey, post.authorPublicKey);

    db.transaction(() => {
        // Ensure synthetic escrow account exists natively
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(`escrow_${tx.id}`);

        // 1. Lock funds — abort if transfer fails
        // Wallet keyed by transaction ID to isolate concurrent recurring-post transactions
        const escrowResult = transfer(buyerPublicKey, `escrow_${tx.id}`, finalCredits, `Escrow hold for offer ${post.id}`, 'escrow', true);
        if (!escrowResult) throw new Error('Failed to lock funds in escrow — insufficient balance or ledger error');

        // 2. Insert pending tx
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(tx.id, tx.postId, tx.buyerPublicKey, tx.sellerPublicKey, tx.credits, tx.hours ?? null, tx.createdAt);
        
        // 3. Update post — the status='active' guard prevents a second buyer from
        // funding escrow on an already-committed item (aborts the whole transaction)
        if (!post.repeatable) {
            const updated = db.prepare(`UPDATE posts SET status='pending', accepted_by=?, accepted_at=?, pending_transaction_id=?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND status='active'`).run(buyerPublicKey, tx.createdAt, tx.id, post.id);
            if (updated.changes === 0) throw new Error('Post is no longer available — it is already committed to another deal');

            // 4. Reject competing open requests — the item is now committed to this buyer.
            // Without this, the author could later approve a stale request and double-sell.
            db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND id!=? AND status='requested'`)
              .run(post.id, tx.id);
        }
    })();
    broadcast({ type: 'post_accepted', postId: post.id, transaction: tx });

    // Post-commit side effects must never fail the API call — the escrow is
    // already funded, and a thrown error here would report failure for a deal
    // that actually succeeded.
    try {
        injectSystemMessage(post.id, SystemMessageType.ESCROW_FUNDED, {
            amount: finalCredits,
            postId: post.id,
            actorPubkey: buyerPublicKey,
            buyerPubkey: buyerPublicKey,
            sellerPubkey: post.authorPublicKey
        }, buyerPublicKey, post.authorPublicKey);
    } catch (e) {
        console.warn('[Marketplace] ESCROW_FUNDED system message failed (deal committed):', e);
    }

    // Push notification: the seller should learn immediately that their offer was taken
    dispatchPushNotification(
        [post.authorPublicKey],
        buyerPublicKey,
        '🛒 Offer Accepted',
        `${buyer?.callsign || 'A member'} accepted "${post.title}" — ${finalCredits} Beans are now in escrow.`,
        { screen: 'post', postId: post.id },
        'marketplace'
    );
    return tx;
}

export function completePostTransaction(transactionId: string, confirmerPublicKey: string, finalHours?: number): MarketplaceTransaction & { alreadyCompleted?: boolean } | null {
    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='pending'").get(transactionId) as any;
    
    // Idempotency: If already completed by the same buyer, return success instead of an error
    if (!row) {
        const completedRow = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='completed'").get(transactionId) as any;
        if (completedRow && completedRow.buyer_pubkey === confirmerPublicKey) {
            const existing = getMarketplaceTransaction(transactionId);
            if (existing) return { ...existing, alreadyCompleted: true };
        }
        return null;
    }
    
    // Security Fix: IN Escrow, the Payer (buyer) is the ONLY one authorized to release funds to the Payee (seller).
    if (row.buyer_pubkey !== confirmerPublicKey) return null;

    const post = db.prepare("SELECT * FROM posts WHERE id=?").get(row.post_id) as any;
    const completedAt = new Date().toISOString();

    let txnRecord: Transaction | undefined;
    
    db.transaction(() => {
        if (finalHours !== undefined && post && post.price_type !== 'fixed' && finalHours > 0) {
            row.hours = finalHours;
            row.credits = post.credits * finalHours;
            db.prepare(`UPDATE marketplace_transactions SET hours=?, credits=? WHERE id=?`).run(row.hours, row.credits, transactionId);
        }

        if (row.credits > 0 && post) {
            // Funds are stored in escrow_${tx_id} since the transaction went 'pending'
            // Transfer whatever the escrow wallet actually holds (may be slightly less than row.credits due to demurrage decay)
            const escrowKey = `escrow_${transactionId}`;
            const escrowAcc = ledger.getAccount(escrowKey);
            const releaseAmount = escrowAcc ? Math.min(escrowAcc.balance, row.credits) : row.credits;
            const releaseResult = transfer(escrowKey, row.seller_pubkey, releaseAmount, `Completed: ${post.title}`, 'escrow');
            if (!releaseResult) {
                throw new Error(`Failed to release ${releaseAmount} beans from ${escrowKey} to ${row.seller_pubkey}`);
            }

            // Sweep any remainder back to the buyer — e.g. an hourly deal settled with
            // fewer finalHours than were escrowed. Without this the difference would be
            // stranded in the escrow wallet forever (it is demurrage-exempt).
            const remainder = ledger.getAccount(escrowKey)?.balance ?? 0;
            if (remainder > 0.0001) {
                transfer(escrowKey, row.buyer_pubkey, remainder, `Escrow overpayment refund: ${post.title}`, 'escrow', true);
            }
        }

        db.prepare(`UPDATE marketplace_transactions SET status='completed', completed_at=? WHERE id=?`).run(completedAt, transactionId);
        
        if (post && !post.repeatable) {
            db.prepare(`UPDATE posts SET status='completed', active=0, completed_at=?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(completedAt, post.id);
        } else if (post && post.repeatable) {
            db.prepare(`UPDATE posts SET status='active', accepted_by=NULL, accepted_at=NULL, pending_transaction_id=NULL, completed_at=?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(completedAt, post.id);
        }
    })();

    const tx = getMarketplaceTransaction(transactionId)!;
    broadcast({ type: 'transaction_completed', transaction: tx });
    
    try {
        injectSystemMessage(row.post_id, SystemMessageType.ESCROW_RELEASED, {
            amount: row.credits,
            postId: row.post_id,
            actorPubkey: confirmerPublicKey,
            buyerPubkey: row.buyer_pubkey,
            sellerPubkey: row.seller_pubkey
        }, row.buyer_pubkey, row.seller_pubkey);
    } catch (e) {
        console.warn('[Marketplace] ESCROW_RELEASED system message failed (settlement committed):', e);
    }
    return tx;
}

export function cancelPostTransaction(transactionId: string, cancellerPublicKey: string): MarketplaceTransaction | null {
    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='pending'").get(transactionId) as any;
    if (!row || (row.buyer_pubkey !== cancellerPublicKey && row.seller_pubkey !== cancellerPublicKey)) return null;

    db.transaction(() => {
        // Reverse Escrow Funds -> Refund Buyer (wallet keyed by transaction ID)
        // Transfer whatever the escrow wallet actually holds (may be slightly less due to demurrage)
        const escrowKey = `escrow_${transactionId}`;
        const escrowAcc = ledger.getAccount(escrowKey);
        // Refund the full escrow balance, not min(balance, credits) — leaves nothing stranded
        const refundAmount = escrowAcc ? escrowAcc.balance : row.credits;
        if (refundAmount > 0.0001) {
            transfer(escrowKey, row.buyer_pubkey, refundAmount, `Escrow refund for cancelled post ${row.post_id}`, 'escrow', true);
        }

        db.prepare(`UPDATE marketplace_transactions SET status='cancelled', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(transactionId);
        const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(row.post_id) as any;
        if (post && !post.repeatable && post.status === 'pending') {
            db.prepare(`UPDATE posts SET status='active', accepted_by=NULL, accepted_at=NULL, pending_transaction_id=NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(post.id);
        }
    })();
    const tx = getMarketplaceTransaction(transactionId)!;
    broadcast({ type: 'transaction_cancelled', transaction: tx });
    
    try {
        injectSystemMessage(row.post_id, SystemMessageType.ESCROW_CANCELLED, {
            amount: row.credits,
            postId: row.post_id,
            actorPubkey: cancellerPublicKey,
            buyerPubkey: row.buyer_pubkey,
            sellerPubkey: row.seller_pubkey
        }, row.buyer_pubkey, row.seller_pubkey);
    } catch (e) {
        console.warn('[Marketplace] ESCROW_CANCELLED system message failed (refund committed):', e);
    }
    return tx;
}

export function pausePost(postId: string, authorPublicKey: string): boolean {
    const result = db.prepare(`UPDATE posts SET status='paused', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND author_pubkey=? AND status='active'`).run(postId, authorPublicKey);
    if (result.changes === 0) return false;
    broadcast({ type: 'post_updated', post: getPosts({ id: postId })[0] });
    return true;
}

export function resumePost(postId: string, authorPublicKey: string): boolean {
    const result = db.prepare(`UPDATE posts SET status='active', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND author_pubkey=? AND status='paused'`).run(postId, authorPublicKey);
    if (result.changes === 0) return false;
    broadcast({ type: 'post_updated', post: getPosts({ id: postId })[0] });
    return true;
}

/**
 * Fetch a single transaction by its primary key. Replaces the
 * `getMarketplaceTransactions(pubkey).find(t => t.id === id)` anti-pattern: that getter
 * applies `LIMIT 50`, so a transaction outside the latest 50 was silently missed (the
 * callers then `!`-asserted it, broadcasting `undefined`). This is O(1) and never paginates.
 */
export function getMarketplaceTransaction(transactionId: string): MarketplaceTransaction | null {
    const r = db.prepare(`
        SELECT mt.*, p.title as postTitle, m1.callsign as buyerCallsign, m2.callsign as sellerCallsign,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.buyer_pubkey) as ratedByBuyer,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.seller_pubkey) as ratedBySeller
        FROM marketplace_transactions mt
        LEFT JOIN posts p ON mt.post_id = p.id
        LEFT JOIN members m1 ON mt.buyer_pubkey = m1.public_key
        LEFT JOIN members m2 ON mt.seller_pubkey = m2.public_key
        WHERE mt.id = ?
    `).get(transactionId) as any;
    if (!r) return null;

    // Cover image as a versioned photo URL — never the base64 bytes. Same pattern as
    // getPosts: the bytes download lazily via /photos/:orderNum (immutable-cached), so
    // a transaction row costs a short string instead of ~200KB. Embedding the bytes
    // here made /api/marketplace/transactions?limit=50 a 9.8MB response that phones
    // re-downloaded and JSON-parsed every sync cycle (measured 2026-07-18).
    const coverImageRow = db.prepare(`SELECT order_num, updated_at FROM post_photos WHERE post_id = ? ORDER BY order_num ASC LIMIT 1`).get(r.post_id) as any;
    const coverImage = coverImageRow
        ? `/api/marketplace/posts/${r.post_id}/photos/${coverImageRow.order_num}?v=${coverImageRow.updated_at ? new Date(coverImageRow.updated_at).getTime() : 0}`
        : null;
    // Mirror the exact shape getMarketplaceTransactions() returns (incl. the rating/cover
    // extras). Returned via a variable so it isn't treated as a fresh literal under excess-
    // property checks — same reason the sibling getter builds these inside a .map().
    const tx = {
        id: r.id, postId: r.post_id, postTitle: r.postTitle, buyerPublicKey: r.buyer_pubkey, buyerCallsign: r.buyerCallsign, sellerPublicKey: r.seller_pubkey, sellerCallsign: r.sellerCallsign, credits: r.credits, status: r.status, createdAt: r.created_at, completedAt: r.completed_at, ratedByBuyer: !!r.ratedByBuyer, ratedBySeller: !!r.ratedBySeller, coverImage
    };
    return tx;
}

export function getMarketplaceTransactions(publicKey: string, filter?: { status?: string }, limit = 50, offset = 0): MarketplaceTransaction[] {
    let query = `
        SELECT mt.*, p.title as postTitle, m1.callsign as buyerCallsign, m2.callsign as sellerCallsign,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.buyer_pubkey) as ratedByBuyer,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.seller_pubkey) as ratedBySeller
        FROM marketplace_transactions mt
        LEFT JOIN posts p ON mt.post_id = p.id
        LEFT JOIN members m1 ON mt.buyer_pubkey = m1.public_key
        LEFT JOIN members m2 ON mt.seller_pubkey = m2.public_key
        WHERE (mt.buyer_pubkey = ? OR mt.seller_pubkey = ?)
    `;
    const params: any[] = [publicKey, publicKey];
    if (filter?.status) { query += " AND mt.status = ?"; params.push(filter.status); }
    query += " ORDER BY mt.created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params) as any[];
    const postIds = Array.from(new Set(rows.map(r => r.post_id)));
    // Only the metadata needed to build versioned photo URLs — never photo_data.
    // Loading the bytes here put ~10MB of base64 into every 50-row response.
    const photos = selectInChunks(postIds, ph => `SELECT post_id, order_num, updated_at FROM post_photos WHERE post_id IN (${ph})`);

    // ⚡ Bolt: Group photos by post_id to avoid O(N²) nested searching
    const photosByPost = new Map<string, any[]>();
    for (const p of photos as any[]) {
        if (!photosByPost.has(p.post_id)) {
            photosByPost.set(p.post_id, []);
        }
        photosByPost.get(p.post_id)!.push(p);
    }

    return rows.map(r => {
        const postPhotos = photosByPost.get(r.post_id) || [];
        const coverImageRow = postPhotos.find(p => p.order_num === 0) || postPhotos[0];
        // Versioned URL, not bytes — see getMarketplaceTransaction above. Existing
        // clients already resolve relative cover paths against their anchor URL.
        const coverImage = coverImageRow
            ? `/api/marketplace/posts/${r.post_id}/photos/${coverImageRow.order_num}?v=${coverImageRow.updated_at ? new Date(coverImageRow.updated_at).getTime() : 0}`
            : null;
        return {
            id: r.id, postId: r.post_id, postTitle: r.postTitle, buyerPublicKey: r.buyer_pubkey, buyerCallsign: r.buyerCallsign, sellerPublicKey: r.seller_pubkey, sellerCallsign: r.sellerCallsign, credits: r.credits, status: r.status, createdAt: r.created_at, completedAt: r.completed_at, ratedByBuyer: !!r.ratedByBuyer, ratedBySeller: !!r.ratedBySeller, coverImage
        };
    });
}
// ===================== COMMUNITY INFO =====================

export function getCommunityInfo(): { memberCount: number; postCount: number; transactionCount: number; commonsBalance: number; currency: { type: string, value: string } } {
    const memberCount = (db.prepare("SELECT COUNT(*) as c FROM members WHERE status != 'pruned'").get() as any).c;
    const postCount = (db.prepare("SELECT COUNT(*) as c FROM posts WHERE active=1").get() as any).c;
    const txCount = (db.prepare("SELECT COUNT(*) as c FROM transactions").get() as any).c;
    const config = getLocalConfig();
    return { memberCount, postCount, transactionCount: txCount, commonsBalance: Math.round(COMMONS_BALANCE * 100) / 100, currency: { type: config.currencyType || 'image', value: config.currencyValue || 'bean' } };
}

/**
 * O(1) count of live, listable posts — the same set getPosts({}) returns (active AND
 * status in active/pending), so it EXCLUDES paused posts. Intentionally narrower than
 * getCommunityInfo().postCount (which counts all active=1, paused included).
 */
export function getActivePostCount(): number {
    return (db.prepare("SELECT COUNT(*) as c FROM posts WHERE active=1 AND status IN ('active', 'pending')").get() as any).c;
}

// ===================== MESSAGING =====================

export function createConversation(type: 'dm' | 'group', participants: string[], createdBy: string, name?: string, postId?: string): Conversation | null {
    assertMemberActive(createdBy);
    for (const p of participants) if (!getMember(p)) registerVisitor(p);

    // Consolidated model: DMs are always post-agnostic (post_id IS NULL) to maintain a single per-pair thread.
    const effectivePostId = type === 'dm' ? undefined : postId;

    if (type === 'dm' && participants.length === 2) {
        // Find existing DM (always post_id IS NULL)
        const existingQuery = `
            SELECT c.* FROM conversations c
            JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.public_key = ?
            JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.public_key = ?
            WHERE c.type = 'dm' AND c.post_id IS NULL
        `;
        const existingParams = [participants[0], participants[1]];

        const existing = db.prepare(existingQuery).get(...existingParams) as any;

        if (existing) {
            const parts = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(existing.id) as any[];
            return { id: existing.id, type: existing.type, postId: existing.post_id, name: existing.name, createdBy: existing.created_by, createdAt: existing.created_at, participants: parts.map(p => p.public_key) };
        }
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    db.transaction(() => {
        db.prepare(`INSERT INTO conversations (id, type, post_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, type, effectivePostId || null, name || null, createdBy, createdAt);
        const insertPart = db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)`);
        for (const p of participants) insertPart.run(id, p);
    })();

    const conv: Conversation = { id, type, postId, name: name || null, createdBy, createdAt, participants };
    broadcast({ type: 'conversation_created', conversation: conv });
    return conv;
}

export function sendMessage(conversationId: string, authorPubkey: string, ciphertext: string, nonce: string, type: 'text' | 'image' = 'text', attachment?: { data: string; nonce: string; mime?: string }, metadata?: string): Message | null {
    assertMemberActive(authorPubkey);
    const participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(conversationId) as any[];
    if (!participants.length || !participants.find(p => p.public_key === authorPubkey)) return null;

    const msg: Message = { id: crypto.randomUUID(), conversationId, authorPubkey, ciphertext, nonce, type, metadata, timestamp: new Date().toISOString() };
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(msg.id, msg.conversationId, msg.authorPubkey, msg.ciphertext, msg.nonce, msg.type, msg.metadata, msg.timestamp);
    // Store the encrypted image blob separately so it lazy-loads (kept out of the message feed).
    if (attachment?.data && attachment?.nonce) {
        db.prepare(`INSERT INTO message_attachments (message_id, data, nonce, mime) VALUES (?, ?, ?, ?)`).run(msg.id, attachment.data, attachment.nonce, attachment.mime || 'image/jpeg');
    }

    broadcast({ type: 'new_message', conversationId, message: msg, participants: participants.map(p => p.public_key) });

    // Push notification for DMs (encrypted — body cannot include message content)
    const senderMember = getMember(authorPubkey) as any;
    const senderName = senderMember?.callsign || authorPubkey.slice(0, 8);
    dispatchPushNotification(
        participants.map(p => p.public_key),
        authorPubkey,
        '💬 New Message',
        `${senderName} sent you a message`,
        { screen: 'chat', conversationId },
        'chat'
    );

    return msg;
}

export function toggleMessageReaction(messageId: string, authorPubkey: string, emoji: string): any {
    const row = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId) as any;
    if (!row) return null;

    let metadata: any = {};
    if (row.metadata) {
        try {
            metadata = JSON.parse(row.metadata);
        } catch {
            metadata = {};
        }
    }

    if (!metadata.reactions) {
        metadata.reactions = [];
    }

    const existingIndex = metadata.reactions.findIndex((r: any) => r.author === authorPubkey);
    if (existingIndex > -1) {
        const existingReaction = metadata.reactions[existingIndex];
        if (existingReaction.emoji === emoji) {
            // Remove the reaction if same emoji
            metadata.reactions.splice(existingIndex, 1);
        } else {
            // Update the reaction to new emoji
            metadata.reactions[existingIndex].emoji = emoji;
        }
    } else {
        // Add new reaction
        metadata.reactions.push({ emoji, author: authorPubkey });
    }

    const metadataStr = JSON.stringify(metadata);
    db.prepare("UPDATE messages SET metadata=? WHERE id=?").run(metadataStr, messageId);

    // Broadcast the update to all active WS clients
    const participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(row.conversation_id) as any[];
    broadcast({
        type: 'message_reaction',
        conversationId: row.conversation_id,
        messageId,
        metadata: metadataStr,
        participants: participants.map(p => p.public_key)
    });

    return { success: true, metadata: metadataStr };
}

/** How long after sending a message the author may still edit it. */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Edit a message's content within MESSAGE_EDIT_WINDOW_MS of sending. Author-only, text-only.
 * The window is enforced against the SERVER clock (the authoritative timestamp), so a client
 * cannot extend it. Throws with a user-facing reason on rejection. On success the new
 * ciphertext/nonce replace the old and edited_at is stamped, then broadcast for re-sync.
 */
export function editMessage(messageId: string, authorPubkey: string, ciphertext: string, nonce: string): Message {
    assertMemberActive(authorPubkey);
    const row = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId) as any;
    if (!row) throw new Error('Message not found');
    if (row.author_pubkey !== authorPubkey) throw new Error('You can only edit your own messages');
    if (row.type === 'image' || row.system_type) throw new Error('Only text messages can be edited');
    if (Date.now() - new Date(row.timestamp).getTime() > MESSAGE_EDIT_WINDOW_MS) {
        throw new Error('The 15-minute edit window for this message has passed');
    }

    const editedAt = new Date().toISOString();
    db.prepare("UPDATE messages SET ciphertext=?, nonce=?, edited_at=? WHERE id=?").run(ciphertext, nonce, editedAt, messageId);

    const participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(row.conversation_id) as any[];
    broadcast({
        type: 'message_edited',
        conversationId: row.conversation_id,
        messageId,
        ciphertext,
        nonce,
        editedAt,
        participants: participants.map(p => p.public_key)
    });

    return { id: messageId, conversationId: row.conversation_id, authorPubkey, ciphertext, nonce, type: row.type, metadata: row.metadata, timestamp: row.timestamp, editedAt };
}

/**
 * Ensures a conversation thread exists between buyer and seller for a given post.
 * Called atomically with escrow creation so injectSystemMessage() always has a target.
 * Returns the conversation ID (existing or newly created).
 */
export function ensureTransactionConversation(_postId: string, buyerPubkey: string, sellerPubkey: string): string {
    // Consolidated model: all trades AND general DMs between two people share ONE per-pair
    // conversation. The postId is no longer part of the thread's identity — it lives in each
    // escrow system message's metadata so the client can still render it as a per-deal event.
    // createConversation's dm dedup (post_id IS NULL) finds the existing pair thread or makes it.
    const conv = createConversation('dm', [buyerPubkey, sellerPubkey], buyerPubkey);
    if (!conv) throw new Error('Failed to create transaction conversation');
    return conv.id;
}

/**
 * One-time chat-consolidation migration: collapse every per-post conversation into the single
 * per-pair DM. For each post-keyed thread we ensure the pair's DM exists, then drop the
 * post-keyed thread (and its messages/participants). New escrow events already target the
 * per-pair DM, and the deals themselves live in marketplace_transactions, so a pending deal's
 * card still appears in the pair thread afterwards. Pre-launch reset — historical per-post chat
 * threads are intentionally discarded. Idempotent: a no-op once no post-keyed threads remain.
 */
export function migrateConsolidateConversations(): void {
    const postKeyed = db.prepare("SELECT id FROM conversations WHERE post_id IS NOT NULL").all() as any[];
    if (postKeyed.length === 0) return;
    console.log(`[Migration] Consolidating ${postKeyed.length} per-post conversation(s) into per-pair DMs...`);

    // Ensure a per-pair DM exists and move messages to it
    db.transaction(() => {
        for (const conv of postKeyed) {
            const parts = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(conv.id) as any[];
            if (parts.length === 2) {
                try {
                    const targetConv = createConversation('dm', [parts[0].public_key, parts[1].public_key], parts[0].public_key);
                    if (targetConv) {
                        // Move all messages to the target consolidated conversation and record the original conversation ID
                        const msgs = db.prepare("SELECT id, metadata FROM messages WHERE conversation_id=?").all(conv.id) as any[];
                        for (const msg of msgs) {
                            let meta: any = {};
                            if (msg.metadata) {
                                try {
                                    meta = JSON.parse(msg.metadata);
                                } catch (e) {}
                            }
                            meta.originalConversationId = conv.id;
                            db.prepare("UPDATE messages SET conversation_id=?, metadata=? WHERE id=?").run(targetConv.id, JSON.stringify(meta), msg.id);
                        }
                    }
                } catch (e) {
                    console.warn('[Migration] Could not ensure per-pair DM or move messages:', (e as any)?.message);
                }
            }
            db.prepare("DELETE FROM conversation_participants WHERE conversation_id=?").run(conv.id);
            writeTombstone('conversations', conv.id);
            for (const p of parts) {
                writeTombstone('conversation_participants', `${conv.id}|${p.public_key}`);
            }
            db.prepare("DELETE FROM conversations WHERE id=?").run(conv.id);
        }
    })();

    console.log(`[Migration] Chat consolidation complete — ${postKeyed.length} per-post thread(s) collapsed.`);
}

export function repairConsolidatedMessagesMetadata(): void {
    try {
        const dms = db.prepare("SELECT id FROM conversations WHERE type = 'dm' AND post_id IS NULL").all() as any[];
        let repairCount = 0;
        for (const dm of dms) {
            const parts = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id = ?").all(dm.id) as any[];
            if (parts.length !== 2) continue;
            
            // Find all legacy/deleted conversation IDs between these two participants
            const legacyRows = db.prepare(`
                SELECT DISTINCT substr(tp1.row_key, 1, instr(tp1.row_key, '|') - 1) AS legacy_conv_id
                FROM tombstones tp1
                JOIN tombstones tp2 ON substr(tp1.row_key, 1, instr(tp1.row_key, '|') - 1) = substr(tp2.row_key, 1, instr(tp2.row_key, '|') - 1)
                WHERE tp1.table_name = 'conversation_participants'
                  AND tp2.table_name = 'conversation_participants'
                  AND tp1.row_key LIKE ?
                  AND tp2.row_key LIKE ?
                  AND tp1.row_key != tp2.row_key
            `).all(`%|${parts[0].public_key}`, `%|${parts[1].public_key}`) as any[];
            
            const legacyIds = legacyRows.map(r => r.legacy_conv_id);
            if (legacyIds.length === 0) continue;
            
            // Fetch messages in this consolidated conversation
            const msgs = db.prepare("SELECT id, metadata FROM messages WHERE conversation_id = ?").all(dm.id) as any[];
            for (const msg of msgs) {
                let meta: any = {};
                if (msg.metadata) {
                    try {
                        meta = JSON.parse(msg.metadata);
                    } catch (e) {}
                }
                
                // If it already has originalConversationId or originalConversationIds, skip it
                if (meta.originalConversationId || meta.originalConversationIds) continue;
                
                // If there's exactly 1 legacy ID, set originalConversationId
                if (legacyIds.length === 1) {
                    meta.originalConversationId = legacyIds[0];
                } else {
                    // Set all candidate original conversation IDs as an array
                    meta.originalConversationIds = legacyIds;
                }
                
                db.prepare("UPDATE messages SET metadata = ? WHERE id = ?").run(JSON.stringify(meta), msg.id);
                repairCount++;
            }
        }
        if (repairCount > 0) {
            console.log(`[Repair] Added legacy conversation IDs to ${repairCount} consolidated message(s) metadata.`);
        }
    } catch (err) {
        console.warn('[Repair] Failed to repair consolidated messages metadata:', err);
    }
}

export function injectSystemMessage(postId: string, type: SystemMessageType, meta: SystemMessageMetadata, buyerPubkey?: string, sellerPubkey?: string) {
    let convRows: any[];
    
    // Consolidated model: deliver into the single per-pair DM (post-agnostic). postId stays in
    // `meta` so the client renders this as a per-deal event in the shared thread. The legacy
    // post_id lookup is kept only as a fallback for callers that don't pass both parties.
    if (buyerPubkey && sellerPubkey) {
        convRows = db.prepare(`
            SELECT c.id FROM conversations c
            JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.public_key = ?
            JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.public_key = ?
            WHERE c.type = 'dm' AND c.post_id IS NULL
        `).all(buyerPubkey, sellerPubkey) as any[];
    } else {
        convRows = db.prepare("SELECT id FROM conversations WHERE post_id = ?").all(postId) as any[];
    }
    
    if (convRows.length === 0) {
        console.warn(`[Comms] WARNING: No conversations found for post ${postId}. System event ${type} was NOT delivered to any inbox.`);
    }

    const contentMap: Record<SystemMessageType, string> = {
        [SystemMessageType.ESCROW_CREATED]: `Escrow initialized.`,
        [SystemMessageType.ESCROW_FUNDED]: `${meta.amount} Beans placed in escrow.`,
        [SystemMessageType.ESCROW_RELEASED]: `Payment of ${meta.amount} Beans released to the provider.`,
        [SystemMessageType.ESCROW_CANCELLED]: `Escrow cancelled and funds refunded.`,
        [SystemMessageType.DISPUTE_OPENED]: `A dispute has been opened.`,
        [SystemMessageType.REVIEW_LEFT]: `A review has been left.`
    };
    
    for (const row of convRows) {
        const conversationId = row.id;
        const participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(conversationId) as any[];
        
        const metadataString = JSON.stringify(meta);
        const msg: Message = { 
            id: crypto.randomUUID(), 
            conversationId, 
            authorPubkey: 'SYSTEM', 
            ciphertext: contentMap[type] || 'System Event occurring.', 
            nonce: '00000', 
            type: 'system',
            systemType: type,
            metadata: metadataString,
            timestamp: new Date().toISOString() 
        };
        db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, system_type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(msg.id, msg.conversationId, msg.authorPubkey, msg.ciphertext, msg.nonce, msg.type, msg.systemType, msg.metadata, msg.timestamp);

        broadcast({ type: 'new_message', conversationId, message: msg, participants: participants.map(p => p.public_key) });
        
        // Dispatch push notification to all participants (except the actor)
        sendPushNotification(postId, type, meta, participants.map(p => p.public_key));
    }
}

export function getConversationsByMember(pubkey: string): Conversation[] {
    const rows = db.prepare(`
        SELECT c.*,
        CASE WHEN c.post_id IS NOT NULL AND p.id IS NULL THEN '(deleted post)' ELSE p.title END as post_title,
        COALESCE(
            (SELECT mt2.status FROM marketplace_transactions mt2
             WHERE mt2.post_id = c.post_id
               AND mt2.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
               AND mt2.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
             ORDER BY mt2.created_at DESC LIMIT 1),
            p.status,
            CASE WHEN c.post_id IS NOT NULL THEN 'cancelled' ELSE 'active' END
        ) as post_status,
        m.type as last_msg_type, m.system_type as last_sys_type, m.timestamp as last_msg_time
        FROM conversations c
        JOIN conversation_participants cp ON c.id = cp.conversation_id
        LEFT JOIN posts p ON c.post_id = p.id
        LEFT JOIN messages m ON m.rowid = (
            SELECT MAX(rowid) FROM messages WHERE conversation_id = c.id
        )
        WHERE cp.public_key = ?
        ORDER BY (m.rowid IS NULL) ASC, m.rowid DESC, c.created_at DESC
    `).all(pubkey) as any[];
    // Ordering uses message rowid (server insertion order) rather than client-supplied
    // timestamps — a device with a skewed clock can no longer sink or float a thread.
    // Message-less conversations sort below messaged ones, newest first.

    // ⚡ Bolt: Batch fetch participants to avoid N+1 queries
    const conversationIds = rows.map(r => r.id);
    const participantsByConv = new Map<string, string[]>();
    const peerLastReadByConv = new Map<string, string | null>();
    const myLastReadByConv = new Map<string, string | null>();
    const allPeerPubkeys = new Set<string>();

    if (conversationIds.length > 0) {
        const allParts = selectInChunks(conversationIds, ph => `SELECT conversation_id, public_key, last_read_at FROM conversation_participants WHERE conversation_id IN (${ph})`);

        for (const part of allParts) {
            if (!participantsByConv.has(part.conversation_id)) {
                participantsByConv.set(part.conversation_id, []);
            }
            participantsByConv.get(part.conversation_id)!.push(part.public_key);
            if (part.public_key !== pubkey) {
                allPeerPubkeys.add(part.public_key);
                // Track the peer's read cursor for read receipts (DM = the one peer).
                peerLastReadByConv.set(part.conversation_id, part.last_read_at || null);
            } else {
                myLastReadByConv.set(part.conversation_id, part.last_read_at || null);
            }
        }
    }

    // ⚡ Bolt: Batch fetch peer member data to avoid N+1 queries
    const membersByPubkey = new Map<string, any>();
    if (allPeerPubkeys.size > 0) {
        const pubkeysArray = Array.from(allPeerPubkeys);
        const allMembers = selectInChunks(pubkeysArray, ph => `SELECT public_key, callsign, avatar_url FROM members WHERE public_key IN (${ph})`);

        for (const member of allMembers) {
            membersByPubkey.set(member.public_key, member);
        }
    }

    // ⚡ Bolt: Batch fetch post photos to avoid N+1 queries
    const postIds = Array.from(new Set(rows.map(r => r.post_id).filter(id => id != null)));
    const postPhotosById = new Map<string, string | null>();
    if (postIds.length > 0) {
        const allPosts = selectInChunks(postIds, ph => `SELECT id, photos FROM posts WHERE id IN (${ph})`);

        for (const post of allPosts) {
            let postPhoto: string | null = null;
            if (post.photos) {
                try {
                    const arr = JSON.parse(post.photos);
                    if (Array.isArray(arr) && arr.length > 0) postPhoto = arr[0];
                } catch {}
            }
            postPhotosById.set(post.id, postPhoto);
        }
    }

    return rows.map(r => {
        const parts = participantsByConv.get(r.id) || [];
        
        // Look up peer member data (avatar + callsign) for the other participant
        const peerPubkey = parts.find(p => p !== pubkey);
        let peerCallsign: string | undefined;
        let peerAvatar: string | null = null;
        if (peerPubkey) {
            const peerMember = membersByPubkey.get(peerPubkey);
            if (peerMember) {
                peerCallsign = peerMember.callsign;
                peerAvatar = peerMember.avatar_url || null;
            }
        }

        // Extract first photo from post
        const postPhoto = r.post_id ? (postPhotosById.get(r.post_id) || null) : null;

        return { 
            id: r.id, 
            type: r.type, 
            postId: r.post_id, 
            postTitle: r.post_title,
            postStatus: r.post_status,
            postPhoto,
            lastMsgType: r.last_msg_type,
            lastSysType: r.last_sys_type,
            name: r.name, 
            createdBy: r.created_by, 
            createdAt: r.created_at, 
            participants: parts,
            peerCallsign,
            peerAvatar,
            peerLastReadAt: peerLastReadByConv.get(r.id) || null,
            myLastReadAt: myLastReadByConv.get(r.id) || null,
        };
    });
}

export function getConversationMessages(conversationId: string, limit = 50, offset = 0): Message[] {
    // rowid (insertion order) instead of client timestamps — stable pagination under clock skew
    const rows = db.prepare(`SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(conversationId, limit, offset) as any[];
    return rows.reverse().map(r => ({ id: r.id, conversationId: r.conversation_id, authorPubkey: r.author_pubkey, ciphertext: r.ciphertext, nonce: r.nonce, type: r.type, systemType: r.system_type, metadata: r.metadata, timestamp: r.timestamp, editedAt: r.edited_at }));
}

export function getConversation(id: string): Conversation | undefined {
    const c = db.prepare(`
        SELECT c.*, p.title as post_title,
        COALESCE(
            (SELECT mt2.status FROM marketplace_transactions mt2
             WHERE mt2.post_id = c.post_id
               AND mt2.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
               AND mt2.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
             ORDER BY mt2.created_at DESC LIMIT 1),
            p.status,
            'active'
        ) as post_status
        FROM conversations c 
        LEFT JOIN posts p ON c.post_id = p.id 
        WHERE c.id=?
    `).get(id) as any;
    if (!c) return undefined;
    const parts = db.prepare("SELECT public_key, last_read_at FROM conversation_participants WHERE conversation_id=?").all(id) as any[];
    return {
        id: c.id,
        type: c.type,
        postId: c.post_id,
        postTitle: c.post_title,
        postStatus: c.post_status,
        name: c.name,
        createdBy: c.created_by,
        createdAt: c.created_at,
        participants: parts.map(p => p.public_key),
        // Read receipts: per-participant read cursors so an open chat polling this
        // endpoint can flip sent ticks to read without waiting for a full sync.
        readCursors: parts.map(p => ({ publicKey: p.public_key, lastReadAt: p.last_read_at || null }))
    } as any;
}

// ===================== UNREAD TRACKING =====================

export function markConversationRead(pubkey: string, conversationId: string): void {
    db.prepare(`UPDATE conversation_participants SET last_read_at=? WHERE conversation_id=? AND public_key=?`).run(new Date().toISOString(), conversationId, pubkey);
}

export function getUnreadCounts(pubkey: string): Record<string, number> {
    const rows = db.prepare(`
        SELECT cp.conversation_id, 
               (SELECT COUNT(*) FROM messages m 
                WHERE m.conversation_id = cp.conversation_id 
                  AND m.author_pubkey != ? 
                  AND (cp.last_read_at IS NULL OR m.timestamp > cp.last_read_at)
               ) as unread_count
        FROM conversation_participants cp
        WHERE cp.public_key = ?
    `).all(pubkey, pubkey) as any[];

    const counts: Record<string, number> = {};
    for (const r of rows) if (r.unread_count > 0) counts[r.conversation_id] = r.unread_count;
    return counts;
}

// ===================== STATE SYNC =====================

export interface PostPhoto {
    post_id: string;
    photo_data: string;
    order_num: number;
    /** Source-of-truth mutation watermark used by delta sync for last-writer-wins conflict resolution. */
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
    /** Source-of-truth mutation watermark used by delta sync for last-writer-wins conflict resolution. */
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
}

export interface SyncConversationParticipant {
    conversationId: string;
    publicKey: string;
    lastReadAt: string | null;
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
    reason: string;
    createdAt: string;
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
    /** Source-of-truth mutation watermark used by delta sync for last-writer-wins conflict resolution. */
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
    /** Source-of-truth mutation watermark used by delta sync for last-writer-wins conflict resolution. */
    updatedAt?: string | null;
    ratedByBuyer?: boolean;
    ratedBySeller?: boolean;
}

/**
 * Unified payload envelope used by all sync paths:
 *  - Full reconcile (every 15 min via /beanpool/sync/payload/2.0.0)     — every array populated
 *  - Cursor-based delta pull (every 30s via /beanpool/sync/delta/2.0.0) — only changed rows since `cursor`
 *  - Push-on-write event       (per write via /beanpool/sync/event/2.0.0) — single-row delta envelope
 *
 * Every row carries its own `updated_at`/timestamp so the importer can do
 * last-writer-wins conflict resolution. `tombstones` propagates hard deletes
 * (see writeTombstone in db.ts). `cursor` is the exporter's wall-clock at the
 * moment of capture and becomes the recipient's next `since`.
 */
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
    /**
     * Commons (demurrage) pool balance at snapshot time. Carried so a backup can
     * verify its replicated commons matches the primary (see getReplicaConsistency).
     * Informational only — importRemoteState reconstructs the commons from txns and
     * does not consume this field, so older payloads without it still import.
     */
    commonsBalance?: number;
    abuseReports?: SyncAbuseReport[];
    recoveryRequests?: SyncRecoveryRequest[];
    recoveryApprovals?: SyncRecoveryApproval[];
    tombstones?: { tableName: string; rowKey: string; deletedAt: string }[];
    nodeId: string;
    /**
     * A2-17: wall-clock (ISO) when this payload was generated, included in the
     * SIGNED base so it can't be altered. The backup puller records the latest
     * imported value and rejects a snapshot older-or-equal to it — defeating a
     * replay of a captured-but-validly-signed older snapshot. Optional so legacy
     * P2P payloads without it still verify.
     */
    generatedAt?: string;
    signature?: string;
    publicKey?: string;
}

export function getStateHash(): string {
    const pKeys = db.prepare("SELECT public_key FROM members ORDER BY public_key").all() as any[];
    const pIds = db.prepare("SELECT id FROM posts WHERE active=1 ORDER BY id").all() as any[];
    const data = JSON.stringify({ m: pKeys.map(k => k.public_key), p: pIds.map(i => i.id) });
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}

/* -------------------------------------------------------------------------- */
/*                       Sync cursors (per-peer watermarks)                    */
/* -------------------------------------------------------------------------- */

/**
 * Look up the timestamp of the last successful delta sync with a given peer.
 * Returns null if we've never synced with this peer (caller falls back to
 * full payload exchange).
 */
export function getSyncCursor(peerId: string): string | null {
    const row = db.prepare(`SELECT last_synced_at FROM sync_cursors WHERE peer_id=?`).get(peerId) as { last_synced_at: string } | undefined;
    return row?.last_synced_at ?? null;
}

/**
 * Record that a delta exchange with a peer completed successfully. The cursor
 * value is the exporter's wall-clock at the moment of capture and becomes the
 * `since` parameter for the next pull.
 */
export function setSyncCursor(peerId: string, cursor: string): void {
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO sync_cursors (peer_id, last_synced_at, last_sync_attempt_at)
        VALUES (?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET
            last_synced_at = excluded.last_synced_at,
            last_sync_attempt_at = excluded.last_sync_attempt_at
    `).run(peerId, cursor, now);
}

/**
 * Record that we attempted a sync with a peer (whether it succeeded or not).
 * Used so we don't keep retrying a flapping peer on every tick.
 */
export function recordSyncAttempt(peerId: string): void {
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO sync_cursors (peer_id, last_synced_at, last_sync_attempt_at)
        VALUES (?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET
            last_sync_attempt_at = excluded.last_sync_attempt_at
    `).run(peerId, now, now);  // last_synced_at only used for INSERT path
}

/* -------------------------------------------------------------------------- */
/*                     Import origin tracking (loop prevention)                */
/* -------------------------------------------------------------------------- */

/**
 * Tracks which peer's payload is currently being applied during an active
 * import (set/cleared by importRemoteState). Module-level state is safe here:
 * Node's single-threaded event loop + better-sqlite3's synchronous transactions
 * mean no other code interleaves while an import is in flight.
 */
let currentImportOrigin: string | null = null;

export function getCurrentImportOrigin(): string | null {
    return currentImportOrigin;
}

export async function exportSyncState(nodeId: string): Promise<SyncPayload> {
    // Select all members
    const members = getAllMembers();
    
    // Select all posts, active or inactive
    const postRows = db.prepare("SELECT * FROM posts").all() as any[];
    const posts: MarketplacePost[] = postRows.map(row => ({
        id: row.id,
        type: row.type,
        category: row.category,
        title: row.title,
        description: row.description,
        credits: row.credits,
        priceType: row.price_type || 'fixed',
        authorPublicKey: row.author_pubkey,
        authorCallsign: '', // Not strictly needed for sync insert, but let's provide fallback
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
    }));

    // Select all photos
    const photos = db.prepare("SELECT * FROM post_photos").all() as PostPhoto[];

    // Select all projects
    const projects = db.prepare("SELECT * FROM projects").all() as Project[];

    // Select all ratings
    const ratingRows = db.prepare("SELECT * FROM ratings").all() as any[];
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

    // Disaster Recovery table exports:
    const accountRows = db.prepare("SELECT * FROM accounts").all() as any[];
    const accounts: SyncAccount[] = accountRows.map(row => ({
        publicKey: row.public_key,
        balance: row.balance,
        lastUpdatedAt: row.last_updated_at || row.joined_at || new Date().toISOString(),
        lastDemurrageEpoch: row.last_demurrage_epoch,
    }));

    const transactionRows = db.prepare("SELECT * FROM transactions").all() as any[];
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

    const ratingTxKeys = new Set(ratingRows.map(r => `${r.transaction_id}|${r.rater_pubkey}`));

    const marketplaceTxRows = db.prepare("SELECT * FROM marketplace_transactions").all() as any[];
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

    const friendRows = db.prepare("SELECT * FROM friends").all() as any[];
    const friends: SyncFriend[] = friendRows.map(row => ({
        ownerPubkey: row.owner_pubkey,
        friendPubkey: row.friend_pubkey,
        addedAt: row.added_at,
        isGuardian: Boolean(row.is_guardian),
    }));

    const conversationRows = db.prepare("SELECT * FROM conversations").all() as any[];
    const conversations: SyncConversation[] = conversationRows.map(row => ({
        id: row.id,
        type: row.type,
        postId: row.post_id,
        name: row.name,
        createdBy: row.created_by,
        createdAt: row.created_at,
    }));

    const participantRows = db.prepare("SELECT * FROM conversation_participants").all() as any[];
    const conversationParticipants: SyncConversationParticipant[] = participantRows.map(row => ({
        conversationId: row.conversation_id,
        publicKey: row.public_key,
        lastReadAt: row.last_read_at,
    }));

    const messageRows = db.prepare("SELECT * FROM messages").all() as any[];
    const messages: Message[] = messageRows.map(row => ({
        id: row.id,
        conversationId: row.conversation_id,
        authorPubkey: row.author_pubkey,
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        type: row.type as 'text' | 'system',
        systemType: row.system_type as SystemMessageType,
        metadata: row.metadata || undefined,
        timestamp: row.timestamp,
        editedAt: row.edited_at,
    }));

    const abuseRows = db.prepare("SELECT * FROM abuse_reports").all() as any[];
    const abuseReports: SyncAbuseReport[] = abuseRows.map(row => ({
        id: row.id,
        reporterPubkey: row.reporter_pubkey,
        targetPubkey: row.target_pubkey,
        targetPostId: row.target_post_id,
        reason: row.reason,
        createdAt: row.created_at,
    }));

    const recoveryReqRows = db.prepare("SELECT * FROM recovery_requests").all() as any[];
    const recoveryRequests: SyncRecoveryRequest[] = recoveryReqRows.map(row => ({
        id: row.id,
        oldPubkey: row.old_pubkey,
        newPubkey: row.new_pubkey,
        status: row.status,
        quorumRequired: row.quorum_required,
        createdAt: row.created_at,
        cooldownUntil: row.cooldown_until,
        executedAt: row.executed_at,
        expiresAt: row.expires_at,
        updatedAt: row.updated_at || row.executed_at || row.cooldown_until || row.created_at,
    }));

    const recoveryAppRows = db.prepare("SELECT * FROM recovery_approvals").all() as any[];
    const recoveryApprovals: SyncRecoveryApproval[] = recoveryAppRows.map(row => ({
        requestId: row.request_id,
        guardianPubkey: row.guardian_pubkey,
        decision: row.decision,
        createdAt: row.created_at,
    }));

    const payload: SyncPayload = {
        stateHash: getStateHash(),
        nodeId,
        generatedAt: new Date().toISOString(), // A2-17: signed freshness marker for replay rejection
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
        commonsBalance: Math.round(COMMONS_BALANCE * 100) / 100, // for backup replica-fidelity check
        abuseReports,
        recoveryRequests,
        recoveryApprovals,
    };

    const privateKey = getPrivateKey();
    if (privateKey) {
        try {
            const rawBody = JSON.stringify(payload);
            // A2-23: a full snapshot is the entire ledger in one object/string. The
            // backup importer caps a payload at 10 MB, so a snapshot past that is
            // rejected by the HTTPS backup pull. Warn operators as the snapshot
            // approaches the cliff — the real fix at scale is incremental sync,
            // not a bigger blob.
            if (rawBody.length > 8 * 1024 * 1024) {
                console.warn(`⚠️ [Sync] Snapshot is ${(rawBody.length / 1048576).toFixed(1)} MB — approaching the 10 MB P2P import cap. Prefer delta sync / consider excluding photo blobs for very large communities.`);
            }
            const signatureBytes = await privateKey.sign(new TextEncoder().encode(rawBody));
            payload.signature = Buffer.from(signatureBytes).toString('hex');
            payload.publicKey = Buffer.from(publicKeyToProtobuf(privateKey.publicKey)).toString('hex');
        } catch (e: any) {
            console.error(`[Sync] Failed to sign export payload:`, e.message || e);
        }
    }

    return payload;
}

export async function signSyncPayload(payload: SyncPayload): Promise<SyncPayload> {
    const privateKey = getPrivateKey();
    if (privateKey) {
        try {
            const rawBody = JSON.stringify(payload);
            const signatureBytes = await privateKey.sign(new TextEncoder().encode(rawBody));
            payload.signature = Buffer.from(signatureBytes).toString('hex');
            payload.publicKey = Buffer.from(publicKeyToProtobuf(privateKey.publicKey)).toString('hex');
        } catch (e: any) {
            console.error(`[Sync] Failed to sign payload:`, e.message || e);
        }
    }
    return payload;
}

export interface ImportResult {
    newMembers: number;
    updatedMembers: number;
    newPosts: number;
    updatedPosts: number;
    newTransactions: number;
    accountChanges: number;
    marketplaceTxns: number;
    newMessages: number;
    /** Tombstones successfully applied (rows deleted locally). */
    tombstonesApplied: number;
    /** Rows skipped because local copy was newer (last-writer-wins). */
    conflictsSkipped: number;
}

/* -------------------------------------------------------------------------- */
/*                  Tombstone application (hard-delete propagation)            */
/* -------------------------------------------------------------------------- */

/**
 * Apply a tombstone locally. Maps `tableName` to the correct DELETE statement
 * and splits compound `rowKey` on `|`. Returns true if a row was actually
 * deleted (false = row already gone, e.g. we already applied this tombstone).
 *
 * Whenever you add a new table to delta sync that supports hard-deletes,
 * add a case here AND ensure the corresponding deletion site calls
 * `writeTombstone(tableName, rowKey)` (see db.ts).
 */
function applyTombstoneLocally(tableName: string, rowKey: string): boolean {
    switch (tableName) {
        case 'friends': {
            const [owner, friend] = rowKey.split('|');
            if (!owner || !friend) return false;
            const r = db.prepare(`DELETE FROM friends WHERE owner_pubkey=? AND friend_pubkey=?`).run(owner, friend);
            return r.changes > 0;
        }
        case 'projects': {
            const r = db.prepare(`DELETE FROM projects WHERE id=?`).run(rowKey);
            return r.changes > 0;
        }
        case 'post_photos': {
            const [postId, orderNum] = rowKey.split('|');
            if (!postId || orderNum === undefined) return false;
            const r = db.prepare(`DELETE FROM post_photos WHERE post_id=? AND order_num=?`).run(postId, Number(orderNum));
            return r.changes > 0;
        }
        default:
            console.warn(`[Sync] Ignoring tombstone for unknown table: ${tableName}`);
            return false;
    }
}

/**
 * Look up the local mutation watermark for a row that might be tombstoned.
 * Returns null if the row doesn't exist locally (tombstone applies cleanly).
 * If the local row is newer than the incoming tombstone, the importer skips
 * the delete (a re-creation has happened locally since the tombstone).
 */
function lookupLocalUpdatedAt(tableName: string, rowKey: string): string | null {
    switch (tableName) {
        case 'friends': {
            const [owner, friend] = rowKey.split('|');
            if (!owner || !friend) return null;
            const r = db.prepare(`SELECT added_at AS ts FROM friends WHERE owner_pubkey=? AND friend_pubkey=?`).get(owner, friend) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        case 'projects': {
            const r = db.prepare(`SELECT updated_at AS ts FROM projects WHERE id=?`).get(rowKey) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        case 'post_photos': {
            const [postId, orderNum] = rowKey.split('|');
            if (!postId || orderNum === undefined) return null;
            const r = db.prepare(`SELECT updated_at AS ts FROM post_photos WHERE post_id=? AND order_num=?`).get(postId, Number(orderNum)) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        default:
            return null;
    }
}

/**
 * Parse a ledger `last_updated_at` value to epoch-millis for last-writer-wins
 * comparison. The column is written in two formats across the codebase:
 *   - ISO-8601 with milliseconds + 'Z' (state-engine transfers, demurrage, the
 *     schema DEFAULT) — e.g. "2026-06-19T14:30:00.000Z"
 *   - SQLite CURRENT_TIMESTAMP (db.ts escrow paths) — "YYYY-MM-DD HH:MM:SS",
 *     which is UTC but carries no 'T' separator and no zone designator.
 * A raw lexical string compare would sort the space before 'T' and mis-rank the
 * two formats, so we normalise the CURRENT_TIMESTAMP shape to ISO-UTC before
 * parsing. Returns NaN for missing/unparseable input so callers can fall back to
 * importing (never silently drop a legitimate update on an ambiguous timestamp).
 */
function parseLedgerTs(value: string | null | undefined): number {
    if (!value) return NaN;
    let s = String(value);
    // "2026-06-19 14:30:00" → "2026-06-19T14:30:00Z" (SQLite CURRENT_TIMESTAMP is UTC)
    if (s.length === 19 && s[10] === ' ') s = `${s.replace(' ', 'T')}Z`;
    return Date.parse(s);
}

// SRV-20 (phase 3b): when ENFORCE_LEDGER_AUTH is on, an imported transaction must
// carry verifiable authorship or it is dropped. OFF by default — do NOT flip it
// until system transactions are node-signed (3c) and the ledger migration (3e)
// has run, or legitimate system/legacy rows would be rejected.
const ENFORCE_LEDGER_AUTH = process.env.ENFORCE_LEDGER_AUTH === 'true';

// ── Phase 1: one-directional live backup (SRV-20/21 topology) ───────────────
//
// The live authority everyone transacts against (the PRIMARY) must import NO
// inbound state from anyone — that is the entire win of replacing the
// bidirectional `mirror` with a one-directional backup. State now flows
// primary → backup ONLY: the BACKUP pulls a read-only signed snapshot from the
// primary over HTTPS (see backup-puller.ts) and imports it locally; the primary
// never runs `importRemoteState` on peer data.
//
// `NODE_ROLE` makes "the primary imports from nobody" a STRUCTURAL invariant,
// independent of connector config: the guard at the top of importRemoteState
// throws for any role other than `backup`. This is the opposite of
// re-introducing inbound trust — it is a blanket denial. The dormant SRV-20/21
// signature + mirror-trust + conservation gates still run below it (so a backup
// importing a snapshot is held to the same per-payload checks), as a safety net
// in case a node is ever (mis)configured back into a trusting role.
//
// Defaults to `primary` (fail-safe: an unconfigured node imports nothing). Read
// from a mutable so a promotion can flip it (operator restarts with
// NODE_ROLE=primary on the promoted node), and so tests can drive both roles.
type NodeRole = 'primary' | 'backup';
let nodeRole: NodeRole = process.env.NODE_ROLE === 'backup' ? 'backup' : 'primary';
export function getNodeRole(): NodeRole { return nodeRole; }
export function setNodeRole(role: NodeRole): void {
    nodeRole = role;
    console.log(`[Topology] NODE_ROLE set to '${role}'`);
}

// SRV-20 (conservation guard): the mutual-credit ledger is zero-sum — every
// operation debits one account and credits another by the same amount, and both
// legs travel in the same sync (each bumps last_updated_at). So a legitimate
// import must NOT change the system-wide balance total. A change means the
// payload created value from nothing (a compromised mirror minting credits), so
// the whole import is rejected. Tolerance absorbs cent-rounding noise; tune
// during test-pair validation if legitimate syncs ever trip it.
const LEDGER_CONSERVATION_TOLERANCE = 0.5;

/** A "regular member" account — not a synthetic/system account. */
function isRegularMemberAccount(pk: string): boolean {
    return pk !== 'COMMONS_POOL' && pk !== 'SYSTEM' && pk !== 'genesis'
        && !pk.startsWith('escrow_') && !pk.startsWith('project_');
}

/**
 * SRV-20: verify a transaction's authorship before applying it on import.
 *
 * Two-layer model (see also the conservation guard in the accounts import):
 *  - A direct **member → member** transfer is the only zero-sum forgery the
 *    conservation guard can't catch (it nets to zero), and the only txn whose
 *    signed request body cleanly binds {to, amount, memo}. So it REQUIRES a valid
 *    member signature: signature verifies over the exact signed payload, signer ==
 *    sender, and the signed body matches the txn's economics (no transplanting a
 *    signature onto a different amount/recipient). Under ENFORCE_LEDGER_AUTH an
 *    unsigned/invalid member→member transfer is REJECTED (strict).
 *  - Everything else — demurrage, fees, genesis, and escrow/crowdfund-orchestrated
 *    moves (synthetic from/to) — is accepted here and constrained instead by the
 *    payload-level mirror-trust gate + the conservation guard. Per-txn node
 *    signatures would add no defence (a compromised mirror holds its own node
 *    key). Documented residual: a compromised mirror could forge a *balance-neutral*
 *    escrow chain (deposit+release) that conservation can't see — narrow (needs a
 *    compromised mirror AND control of the payout recipient).
 *
 * NOTE: any node-GENERATED member→member transfer (e.g. a future recovery/admin
 * move) would have no member signature and be rejected under strict mode — must be
 * captured or exempted before flipping the flag; the test-pair validation surfaces
 * any such path.
 */
function verifyTransactionAuthorship(tx: Transaction): boolean {
    // Only member→member transfers are signature-gated; all else relies on the
    // mirror-trust + conservation layers.
    if (!isRegularMemberAccount(tx.from) || !isRegularMemberAccount(tx.to)) return true;
    // Strict: a member→member transfer must carry a verifiable member signature.
    if (!tx.authSigner || !tx.authSignature || !tx.authPayload) return false;
    try {
        const spki = Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'),
            Buffer.from(tx.authSigner, 'hex'),
        ]);
        const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
        const sigOk = crypto.verify(
            undefined, Buffer.from(tx.authPayload), key, Buffer.from(tx.authSignature, 'base64'),
        );
        if (!sigOk) return false;
        // Authorship: the signer must be the sender.
        if (tx.authSigner !== tx.from) return false;
        // Payload↔row consistency: body is everything after the 4th newline of
        // `METHOD\nPATH\nTS\nNONCE\nBODY` (body may itself contain newlines).
        const body = tx.authPayload.split('\n').slice(4).join('\n');
        const signed = JSON.parse(body || '{}');
        if (String(signed.to) !== String(tx.to)) return false;
        if (Number(signed.amount) !== Number(tx.amount)) return false;
        if (String(signed.memo ?? '') !== String(tx.memo ?? '')) return false;
        return true;
    } catch {
        return false;
    }
}

export async function importRemoteState(remote: SyncPayload): Promise<ImportResult> {
    // Phase 1 (one-directional backup): a PRIMARY imports state from NOBODY.
    // This is the structural close of the SRV-20/21 ledger-forgery vector on the
    // live authority — there is no trusted writer to its ledger because there is
    // no inbound import at all. Only a node explicitly running as a `backup`
    // (read replica, pulling the primary's signed snapshot over HTTPS) is allowed
    // past this point; even then the dormant signature + mirror-trust +
    // conservation gates below still apply per-payload. Checked first, before any
    // parsing/verification, so a primary spends zero cycles on hostile input and
    // any inbound snapshot offered to a primary is rejected outright.
    if (nodeRole !== 'backup') {
        throw new Error(`[Sync] This node runs as '${nodeRole}', which imports no remote state (one-directional backup topology). Inbound state rejected.`);
    }

    // Cryptographic validation of P2P Sync Payload
    if (!remote.signature || !remote.publicKey) {
        throw new Error(`[Sync] Cryptographic validation failed: Missing SyncPayload signature or publicKey`);
    }

    try {
        // Construct the unsigned base payload to verify against
        const { signature, publicKey, ...basePayload } = remote;
        const serialized = JSON.stringify(basePayload);
        
        // Reconstruct libp2p public key
        const pubKeyBuffer = Buffer.from(publicKey, 'hex');
        const pubKey = publicKeyFromProtobuf(pubKeyBuffer);
        
        // Verify signature
        const isValid = await pubKey.verify(
            new TextEncoder().encode(serialized),
            Buffer.from(signature, 'hex')
        );

        if (!isValid) {
            throw new Error('Invalid cryptographic signature.');
        }

        // SECURITY (SRV-1) defense-in-depth: a valid signature only proves the
        // payload was signed by whoever owns `publicKey` — NOT that this key
        // belongs to a node we trust. Bind the signing key to a trusted connector
        // PeerID so a self-signed payload from an unknown/attacker key is rejected
        // even if it reaches this path. A node only ever signs its OWN exported
        // snapshot, so the signing key always maps to the connection identity —
        // this has no false negatives for configured peers.
        // Imported dynamically to avoid a module cycle (connector-manager imports
        // state-engine).
        const { peerIdFromPublicKey } = await import('@libp2p/peer-id');
        const signerPeerId = peerIdFromPublicKey(pubKey as any).toString();
        const { isPeerTrusted } = await import('./connector-manager.js');
        const signerTrust = isPeerTrusted(signerPeerId);
        if (!signerTrust.trusted || signerTrust.trustLevel === 'blocked') {
            throw new Error(`Sync payload signing key maps to untrusted peer ${signerPeerId.slice(-8)}`);
        }

        // SECURITY (SRV-20): a sync payload rewrites this node's ledger, members,
        // and message state wholesale, so only a `mirror` connector — a node the
        // operator has explicitly designated for full state replication
        // (backup/disaster-recovery) — may import it. `peer` connectors are
        // cross-community federation links (CORS + API access, NO sync; see
        // connector-manager.ts) and must NOT be able to push ledger state. The
        // SRV-1 gate above only proved the payload came from *a* trusted
        // connector; without this, a compromised or malicious federation peer
        // could forge arbitrary balances/members/transactions.
        if (signerTrust.trustLevel !== 'mirror') {
            throw new Error(`Sync payload signer ${signerPeerId.slice(-8)} is a '${signerTrust.trustLevel}' connector; only 'mirror' connectors may import state`);
        }

        // SECURITY (SRV-20, STILL OUTSTANDING — per-row authorship): the gate
        // above authorizes the *connection* (a mirror connector) but not row
        // *authorship*. A compromised mirror can still assert arbitrary
        // third-party rows. Closing that requires cryptographic per-row
        // authorship — and transactions currently carry NO signature (see the
        // `transactions` schema / `Transaction` type), so the complete fix is a
        // protocol change: sign each transaction at its source and derive
        // balances from the verified ledger rather than trusting imported
        // `balance` values. Balance reconciliation alone is not viable today
        // because escrow/crowdfund paths mutate balances outside the transaction
        // log. The SRV-21 mitigations below (balance LWW + finite guard) plus this
        // mirror-only gate are the contained defenses until then. Tracked in
        // SECURITY-AUDIT.md.
        console.log(`[Sync] ✓ Cryptographically validated sync payload from trusted mirror: ${signerPeerId.slice(-8)} (nodeId: ${remote.nodeId})`);
    } catch (e: any) {
        console.error(`[Sync] ❌ SyncPayload signature validation failed:`, e.message || e);
        throw new Error(`Cryptographic sync payload verification failed: ${e.message}`);
    }

    // A2-11 (SRV-24): the whole payload is applied in ONE synchronous better-sqlite3
    // transaction (uninterruptible on Node's single thread). A pathologically large
    // payload (the audit PoC: ~150k cheap rows in one category) would stall the
    // event loop for seconds every pull tick. Reject a payload whose any category
    // exceeds a generous per-category cap BEFORE entering the transaction. The
    // default (250k) comfortably exceeds a realistic community's per-category row
    // count; very large deployments can raise MAX_IMPORT_ROWS_PER_CATEGORY (the real
    // scaling answer is incremental sync, not a bigger full snapshot).
    const MAX_IMPORT_ROWS = Number(process.env.MAX_IMPORT_ROWS_PER_CATEGORY) || 250_000;
    const importCategories: (keyof SyncPayload)[] = [
        'members', 'posts', 'photos', 'projects', 'ratings', 'accounts', 'transactions',
        'marketplaceTransactions', 'friends', 'conversations', 'conversationParticipants',
        'messages', 'abuseReports', 'recoveryRequests', 'recoveryApprovals', 'tombstones',
    ];
    for (const cat of importCategories) {
        const arr = remote[cat];
        if (Array.isArray(arr) && arr.length > MAX_IMPORT_ROWS) {
            throw new Error(`[Sync] Import payload category '${String(cat)}' has ${arr.length} rows (> ${MAX_IMPORT_ROWS}); rejecting oversized payload to protect the event loop`);
        }
    }

    let newMembers = 0, newPosts = 0;
    let updatedMembers = 0, updatedPosts = 0;
    let newTransactions = 0, accountChanges = 0, marketplaceTxns = 0, newMessages = 0;
    let tombstonesApplied = 0, conflictsSkipped = 0;

    // Record which peer's payload is being applied for the duration of the
    // import. Cleared in the `finally` after the transaction. Module-level state
    // is safe here because Node's event loop + better-sqlite3's synchronous
    // transactions prevent interleaving with concurrent local writes.
    currentImportOrigin = remote.nodeId;
    db.pragma('foreign_keys = OFF');

    try {
    db.transaction(() => {
        // 1. Import/Upsert Members
        for (const rm of remote.members ?? []) {
            const existing = db.prepare("SELECT updated_at FROM members WHERE public_key=?").get(rm.publicKey) as { updated_at: string | null } | undefined;
            if (!existing) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, home_node_url, avatar_url, bio, contact_value, contact_visibility, status, last_active_at, elder_vouched_by, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                    rm.publicKey,
                    rm.callsign,
                    rm.joinedAt,
                    rm.invitedBy,
                    rm.inviteCode,
                    rm.homeNodeUrl || null,
                    rm.avatarUrl || null,
                    rm.bio || null,
                    rm.contactValue || null,
                    rm.contactVisibility || null,
                    rm.status || 'active',
                    rm.lastActiveAt || null,
                    rm.elderVouchedBy || null,
                    rm.updatedAt || rm.joinedAt
                );
                db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(rm.publicKey);
                newMembers++;
            } else {
                // Last-writer-wins: skip if local copy is newer.
                if (rm.updatedAt && existing.updated_at && existing.updated_at >= rm.updatedAt) {
                    conflictsSkipped++;
                    continue;
                }
                // Explicitly write `updated_at` to the source's value so:
                //  (a) LWW semantics are preserved (cursor reflects source mutation time)
                //  (b) the members trigger's `WHEN NEW.updated_at IS OLD.updated_at` guard
                //      evaluates false → no double-bump on top of the source timestamp.
                // elder_vouched_by merges monotonically (COALESCE keeps a local vouch
                // if set) so whole-row LWW can never clear an Elder endorsement, but a
                // remote vouch still lands on a node that hasn't seen it yet.
                const res = db.prepare(`UPDATE members SET
                    callsign = ?,
                    avatar_url = ?,
                    bio = ?,
                    contact_value = ?,
                    contact_visibility = ?,
                    status = ?,
                    last_active_at = ?,
                    elder_vouched_by = COALESCE(elder_vouched_by, ?),
                    updated_at = ?
                    WHERE public_key = ?`).run(
                    rm.callsign,
                    rm.avatarUrl || null,
                    rm.bio || null,
                    rm.contactValue || null,
                    rm.contactVisibility || null,
                    rm.status || 'active',
                    rm.lastActiveAt || null,
                    rm.elderVouchedBy || null,
                    rm.updatedAt || existing.updated_at || new Date().toISOString(),
                    rm.publicKey
                );
                if (res.changes > 0) updatedMembers++;
            }
        }

        // 2. Import/Upsert Posts
        for (const rp of remote.posts ?? []) {
            const existing = db.prepare("SELECT updated_at FROM posts WHERE id=?").get(rp.id) as { updated_at: string | null } | undefined;
            if (!existing) {
                db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, active, status, repeatable, lat, lng, origin_node, price_type, accepted_by, accepted_at, pending_transaction_id, completed_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                    rp.id,
                    rp.type,
                    rp.category,
                    rp.title,
                    rp.description,
                    rp.credits,
                    rp.authorPublicKey,
                    rp.createdAt,
                    rp.active ? 1 : 0,
                    rp.status,
                    rp.repeatable ? 1 : 0,
                    rp.lat ?? null,
                    rp.lng ?? null,
                    rp.originNode || remote.nodeId,
                    rp.priceType || 'fixed',
                    rp.acceptedBy || null,
                    rp.acceptedAt || null,
                    rp.pendingTransactionId || null,
                    rp.completedAt || null,
                    rp.updatedAt || rp.createdAt
                );
                newPosts++;
            } else {
                if (rp.updatedAt && existing.updated_at && existing.updated_at >= rp.updatedAt) {
                    conflictsSkipped++;
                    continue;
                }
                const res = db.prepare(`UPDATE posts SET
                    title = ?,
                    description = ?,
                    credits = ?,
                    active = ?,
                    status = ?,
                    repeatable = ?,
                    price_type = ?,
                    accepted_by = ?,
                    accepted_at = ?,
                    pending_transaction_id = ?,
                    completed_at = ?,
                    lat = ?,
                    lng = ?,
                    updated_at = ?
                    WHERE id = ?`).run(
                    rp.title,
                    rp.description,
                    rp.credits,
                    rp.active ? 1 : 0,
                    rp.status,
                    rp.repeatable ? 1 : 0,
                    rp.priceType || 'fixed',
                    rp.acceptedBy || null,
                    rp.acceptedAt || null,
                    rp.pendingTransactionId || null,
                    rp.completedAt || null,
                    rp.lat ?? null,
                    rp.lng ?? null,
                    rp.updatedAt || existing.updated_at || new Date().toISOString(),
                    rp.id
                );
                if (res.changes > 0) updatedPosts++;
            }
        }

        // 3. Import/Upsert Post Photos
        if (remote.photos) {
            for (const ph of remote.photos) {
                db.prepare(`INSERT OR REPLACE INTO post_photos (post_id, photo_data, order_num) 
                            VALUES (?, ?, ?)`).run(
                    ph.post_id,
                    ph.photo_data,
                    ph.order_num
                );
            }
        }

        // 4. Import/Upsert Projects
        if (remote.projects) {
            for (const pr of remote.projects) {
                db.prepare(`INSERT OR REPLACE INTO projects (id, creator_pubkey, title, description, photos, goal_amount, current_amount, deadline_at, status, created_at) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                    pr.id,
                    pr.creator_pubkey,
                    pr.title,
                    pr.description,
                    pr.photos,
                    pr.goal_amount,
                    pr.current_amount,
                    pr.deadline_at,
                    pr.status,
                    pr.created_at
                );
            }
        }

        // 5. Import/Upsert Ratings (Reputation system)
        if (remote.ratings) {
            for (const rt of remote.ratings) {
                db.prepare(`INSERT OR REPLACE INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment, transaction_id, created_at) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
                    rt.id,
                    rt.targetPubkey,
                    rt.raterPubkey,
                    rt.role,
                    rt.stars,
                    rt.comment || null,
                    rt.transactionId,
                    rt.createdAt
                );
            }
        }

        // 6. Import/Upsert Accounts
        //
        // SECURITY (SRV-21): this upsert previously did an unconditional
        // `balance = excluded.balance`, so a sync payload could rewrite any
        // account to any value with no staleness or integrity guard — i.e. a
        // trusted/compromised connector could mint credits. Two contained
        // mitigations are applied here; per-row authorship authorization (SRV-20)
        // is still outstanding — see the note in `importRemoteState`'s preamble.
        //
        //   (a) Last-writer-wins on `last_updated_at`: skip the overwrite when our
        //       local row is at least as new as the incoming one, mirroring the
        //       members/posts imports above. This stops a stale/replayed payload
        //       (e.g. a periodic full-resync) from clobbering a newer local
        //       balance. Timestamps are compared as parsed epochs via
        //       parseLedgerTs() because the column is written in two formats
        //       (ISO-8601 vs SQLite CURRENT_TIMESTAMP); when either side is
        //       missing/unparseable we fall through and import.
        //   (b) Reject non-finite balances (NaN / ±Infinity / non-number) so a
        //       malformed payload can't corrupt ledger math or the conservation
        //       audit. We deliberately do NOT enforce `balance >= 0`: this is a
        //       mutual-credit ledger where member balances are routinely negative
        //       down to a dynamic floor (CREDIT_BASE_FLOOR -80 … ~-2000), and
        //       COMMONS_POOL / escrow_* / genesis settle with an effectively
        //       unbounded-negative floor — a non-negative CHECK would drop
        //       legitimate sync.
        if (remote.accounts) {
            // (c) SRV-20 conservation: track the net change to the system-wide
            // balance total across this import. A populated node's legitimate
            // import nets to ~0 (zero-sum operations, both legs present); a
            // value-creating forgery shifts it. Skipped while bootstrapping (the
            // first full sync legitimately establishes state from ~empty).
            const accountCountBefore = (db.prepare("SELECT COUNT(*) AS c FROM accounts").get() as { c: number }).c;
            let importedBalanceDelta = 0;

            for (const acc of remote.accounts) {
                // (b) integrity: only finite numeric balances are admissible
                if (typeof acc.balance !== 'number' || !Number.isFinite(acc.balance)) {
                    conflictsSkipped++;
                    continue;
                }
                // (a) last-writer-wins: skip if our copy is at least as fresh
                const existing = db.prepare("SELECT balance, last_updated_at FROM accounts WHERE public_key=?")
                    .get(acc.publicKey) as { balance: number; last_updated_at: string | null } | undefined;
                if (existing) {
                    const localEpoch = parseLedgerTs(existing.last_updated_at);
                    const remoteEpoch = parseLedgerTs(acc.lastUpdatedAt);
                    if (Number.isFinite(localEpoch) && Number.isFinite(remoteEpoch) && localEpoch >= remoteEpoch) {
                        conflictsSkipped++;
                        continue;
                    }
                }
                const res = db.prepare(`INSERT INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch)
                            VALUES (?, ?, ?, ?)
                            ON CONFLICT(public_key) DO UPDATE SET
                                balance = excluded.balance,
                                last_updated_at = excluded.last_updated_at,
                                last_demurrage_epoch = excluded.last_demurrage_epoch`).run(
                    acc.publicKey,
                    acc.balance,
                    acc.lastUpdatedAt,
                    acc.lastDemurrageEpoch
                );
                if (res.changes > 0) {
                    accountChanges++;
                    importedBalanceDelta += acc.balance - (existing?.balance ?? 0);
                }
            }

            // (c) Conservation guard — reject a value-creating import. Thrown
            // inside the db.transaction, so the WHOLE import rolls back. Runs
            // before the in-memory ledger reload below so a rejected import can't
            // desync memory from the (rolled-back) DB. Bootstrapping nodes (≤1
            // pre-existing account, i.e. just the seeded COMMONS_POOL) are exempt.
            //
            // A2-8: this guard runs on a `backup` UNCONDITIONALLY — not only when
            // ENFORCE_LEDGER_AUTH is on. The mutual-credit ledger is zero-sum, so a
            // legitimate full snapshot from the primary nets to ~0 regardless of how
            // far behind the backup is; a non-zero shift means the snapshot created
            // value (a compromised/forged primary), which the backup must refuse
            // rather than replicate. This makes the "a forged snapshot is caught"
            // defense real on a stock backup (it was previously dormant behind the
            // default-off flag). `importRemoteState` only runs as a backup (role
            // guard at the top), so `nodeRole === 'backup'` holds here; the
            // ENFORCE_LEDGER_AUTH disjunct preserves the prior behavior for any
            // future trusting topology. If a *legitimate* snapshot ever trips this,
            // raise LEDGER_CONSERVATION_TOLERANCE — do not disable the guard.
            if ((ENFORCE_LEDGER_AUTH || nodeRole === 'backup') && accountCountBefore > 1
                && Math.abs(importedBalanceDelta) > LEDGER_CONSERVATION_TOLERANCE) {
                throw new Error(`[Sync] Conservation violation: import shifted total balance by ${importedBalanceDelta.toFixed(4)} (> ${LEDGER_CONSERVATION_TOLERANCE}); rejecting value-creating payload`);
            }

            // Reload LedgerManager state in memory to dynamically reflect remote ledger updates
            const updatedAccs = db.prepare("SELECT public_key as id, balance, last_demurrage_epoch as lastDemurrageEpoch FROM accounts").all() as any[];
            ledger.loadState(updatedAccs);
            // Restore commons balance if COMMONS_POOL was in the remote payload —
            // but source the value from the post-import DB row, not the raw remote
            // value, so the LWW decision above can't desync in-memory
            // COMMONS_BALANCE from what actually persisted.
            if (remote.accounts.some(a => a.publicKey === 'COMMONS_POOL')) {
                const commonsRow = db.prepare("SELECT balance FROM accounts WHERE public_key='COMMONS_POOL'")
                    .get() as { balance: number } | undefined;
                if (commonsRow) {
                    setCommonsBalance(commonsRow.balance);
                }
            }
        }

        // 7. Import Immutable Transactions (Ledger Transfers)
        if (remote.transactions) {
            for (const tx of remote.transactions) {
                // SRV-20 (3b): drop transactions whose authorship can't be verified.
                if (ENFORCE_LEDGER_AUTH && !verifyTransactionAuthorship(tx)) {
                    conflictsSkipped++;
                    continue;
                }
                // A2-14 (SRV-26): pre-validate so a CHECK(amount>0)-violating row is
                // counted as an explicit skip rather than SILENTLY swallowed by
                // INSERT OR IGNORE (res.changes==0). A silent drop left the matching
                // imported balance unexplained → accounts/transactions divergence the
                // conservation audit can't reconcile. Bad rows are now visible in
                // conflictsSkipped.
                if (!tx.from || !tx.to || typeof tx.amount !== 'number' || !Number.isFinite(tx.amount) || tx.amount <= 0) {
                    conflictsSkipped++;
                    continue;
                }
                const res = db.prepare(`INSERT OR IGNORE INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp, auth_signer, auth_signature, auth_payload)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                    tx.id,
                    tx.from,
                    tx.to,
                    tx.amount,
                    tx.memo,
                    tx.timestamp,
                    tx.authSigner ?? null,
                    tx.authSignature ?? null,
                    tx.authPayload ?? null,
                );
                if (res.changes > 0) newTransactions++;
            }
        }

        // 8. Import/Upsert Marketplace Escrow Transactions
        if (remote.marketplaceTransactions) {
            for (const mt of remote.marketplaceTransactions) {
                const res = db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at, completed_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id) DO UPDATE SET
                                status = excluded.status,
                                completed_at = excluded.completed_at,
                                hours = excluded.hours,
                                credits = excluded.credits`).run(
                    mt.id,
                    mt.postId ?? mt.post_id ?? null,
                    mt.buyerPubkey ?? mt.buyerPublicKey ?? mt.buyer_pubkey ?? null,
                    mt.sellerPubkey ?? mt.sellerPublicKey ?? mt.seller_pubkey ?? null,
                    mt.credits ?? 0,
                    mt.hours ?? null,
                    mt.status ?? 'pending',
                    mt.createdAt ?? mt.created_at ?? new Date().toISOString(),
                    mt.completedAt ?? mt.completed_at ?? null
                );
                if (res.changes > 0) marketplaceTxns++;
            }
        }

        // 9. Import/Upsert Friends & Guardian Relations
        if (remote.friends) {
            for (const fr of remote.friends) {
                db.prepare(`INSERT INTO friends (owner_pubkey, friend_pubkey, added_at, is_guardian)
                            VALUES (?, ?, ?, ?)
                            ON CONFLICT(owner_pubkey, friend_pubkey) DO UPDATE SET
                                is_guardian = excluded.is_guardian`).run(
                    fr.ownerPubkey,
                    fr.friendPubkey,
                    fr.addedAt,
                    fr.isGuardian ? 1 : 0
                );
            }
        }

        // 10. Import/Upsert Conversations
        if (remote.conversations) {
            for (const cv of remote.conversations) {
                db.prepare(`INSERT INTO conversations (id, type, post_id, name, created_by, created_at)
                            VALUES (?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id) DO UPDATE SET
                                name = excluded.name`).run(
                    cv.id,
                    cv.type,
                    cv.postId || null,
                    cv.name || null,
                    cv.createdBy || null,
                    cv.createdAt
                );
            }
        }

        // 11. Import/Upsert Conversation Participants
        if (remote.conversationParticipants) {
            for (const cp of remote.conversationParticipants) {
                db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key, last_read_at)
                            VALUES (?, ?, ?)
                            ON CONFLICT(conversation_id, public_key) DO UPDATE SET
                                last_read_at = excluded.last_read_at`).run(
                    cp.conversationId,
                    cp.publicKey,
                    cp.lastReadAt || null
                );
            }
        }

        // 12. Import Immutable Chat Messages
        if (remote.messages) {
            for (const msg of remote.messages) {
                // Insert new messages; for ones we already have, only accept a strictly newer
                // edit (edited_at). This lets edits propagate across nodes while leaving
                // un-edited messages immutable and never clobbering a newer edit with an older one.
                const res = db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, system_type, metadata, timestamp, edited_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id) DO UPDATE SET
                                ciphertext = excluded.ciphertext,
                                nonce = excluded.nonce,
                                edited_at = excluded.edited_at
                            WHERE excluded.edited_at IS NOT NULL
                              AND (messages.edited_at IS NULL OR excluded.edited_at > messages.edited_at)`).run(
                    msg.id,
                    msg.conversationId,
                    msg.authorPubkey,
                    msg.ciphertext,
                    msg.nonce,
                    msg.type || 'text',
                    msg.systemType || null,
                    msg.metadata || null,
                    msg.timestamp,
                    msg.editedAt || null
                );
                if (res.changes > 0) newMessages++;
            }
        }

        // 13. Import Immutable Abuse Reports
        if (remote.abuseReports) {
            for (const ar of remote.abuseReports) {
                db.prepare(`INSERT OR IGNORE INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, created_at)
                            VALUES (?, ?, ?, ?, ?, ?)`).run(
                    ar.id,
                    ar.reporterPubkey,
                    ar.targetPubkey,
                    ar.targetPostId || null,
                    ar.reason,
                    ar.createdAt
                );
            }
        }

        // 14. Import/Upsert Social Recovery Requests
        if (remote.recoveryRequests) {
            for (const rr of remote.recoveryRequests) {
                db.prepare(`INSERT INTO recovery_requests (id, old_pubkey, new_pubkey, status, quorum_required, created_at, cooldown_until, executed_at, expires_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id) DO UPDATE SET
                                status = excluded.status,
                                cooldown_until = excluded.cooldown_until,
                                executed_at = excluded.executed_at,
                                expires_at = excluded.expires_at`).run(
                    rr.id,
                    rr.oldPubkey,
                    rr.newPubkey,
                    rr.status,
                    rr.quorumRequired,
                    rr.createdAt,
                    rr.cooldownUntil || null,
                    rr.executedAt || null,
                    rr.expiresAt || null
                );
            }
        }

        // 15. Import Immutable Recovery Approvals
        if (remote.recoveryApprovals) {
            for (const ra of remote.recoveryApprovals) {
                db.prepare(`INSERT OR IGNORE INTO recovery_approvals (request_id, guardian_pubkey, decision, created_at)
                            VALUES (?, ?, ?, ?)`).run(
                    ra.requestId,
                    ra.guardianPubkey,
                    ra.decision,
                    ra.createdAt
                );
            }
        }

        // 16. Apply Tombstones (hard-delete propagation)
        //
        // For each tombstone we received, check whether the local row has
        // been re-created with a newer timestamp than the tombstone — if so,
        // skip the delete (the row was resurrected after the tombstone was
        // written elsewhere). Otherwise apply the DELETE locally AND persist
        // the tombstone in our own tombstones table so we forward it on the
        // next delta export.
        if (remote.tombstones) {
            for (const ts of remote.tombstones) {
                const localTs = lookupLocalUpdatedAt(ts.tableName, ts.rowKey);
                if (localTs && localTs > ts.deletedAt) {
                    conflictsSkipped++;
                    continue;
                }
                const deleted = applyTombstoneLocally(ts.tableName, ts.rowKey);
                db.prepare(`INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at)
                            VALUES (?, ?, ?)`).run(ts.tableName, ts.rowKey, ts.deletedAt);
                if (deleted) tombstonesApplied++;
            }
        }
    })();
    } finally {
        db.pragma('foreign_keys = ON');
        currentImportOrigin = null;
    }

    if (newMembers > 0 || newPosts > 0) {
        broadcast({ type: 'state_synced', newMembers, newPosts, from: remote.nodeId });
    }
    return {
        newMembers,
        updatedMembers,
        newPosts,
        updatedPosts,
        newTransactions,
        accountChanges,
        marketplaceTxns,
        newMessages,
        tombstonesApplied,
        conflictsSkipped,
    };
}
// ===================== RATINGS =====================

export function addRating(raterPubkey: string, targetPubkey: string, stars: number, comment: string, transactionId: string): Rating | null {
    assertMemberActive(raterPubkey);
    if (!getMember(raterPubkey) || !getMember(targetPubkey) || raterPubkey === targetPubkey || stars < 1 || stars > 5) return null;

    const tx = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='completed'").get(transactionId) as any;
    if (!tx || (tx.buyer_pubkey !== raterPubkey && tx.seller_pubkey !== raterPubkey) || (tx.buyer_pubkey !== targetPubkey && tx.seller_pubkey !== targetPubkey)) return null;

    const post = db.prepare("SELECT type FROM posts WHERE id=?").get(tx.post_id) as any;
    const isOffer = post?.type === 'offer';
    const targetRole: 'provider' | 'receiver' = (tx.seller_pubkey === targetPubkey) 
        ? (isOffer ? 'provider' : 'receiver') 
        : (isOffer ? 'receiver' : 'provider');

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    
    // UPSERT pattern
    const existing = db.prepare("SELECT * FROM ratings WHERE transaction_id=? AND rater_pubkey=?").get(transactionId, raterPubkey) as any;
    if (existing) {
        db.prepare("UPDATE ratings SET stars=?, comment=?, created_at=? WHERE id=?").run(stars, comment.slice(0, 200), createdAt, existing.id);
        return { ...existing, stars, comment, createdAt };
    }

    db.prepare(`INSERT INTO ratings (id, target_pubkey, rater_pubkey, stars, comment, role, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, targetPubkey, raterPubkey, stars, comment.slice(0, 200), targetRole, transactionId, createdAt);
    return { id, targetPubkey, raterPubkey, stars, comment: comment.slice(0, 200), role: targetRole, transactionId, createdAt };
}

export function getRatings(targetPubkey: string): any[] {
    const rows = db.prepare(`
        SELECT r.*, m.callsign as rater_callsign, m.avatar_url as rater_avatar
        FROM ratings r
        LEFT JOIN members m ON r.rater_pubkey = m.public_key
        WHERE r.target_pubkey=?
        ORDER BY r.created_at DESC
    `).all(targetPubkey) as any[];
    return rows.map(r => ({
        id: r.id,
        targetPubkey: r.target_pubkey,
        raterPubkey: r.rater_pubkey,
        stars: r.stars,
        comment: r.comment,
        role: r.role,
        transactionId: r.transaction_id,
        createdAt: r.created_at,
        rater_callsign: r.rater_callsign,
        rater_avatar: r.rater_avatar
    }));
}

export function getRatingsGiven(raterPubkey: string): Rating[] {
    const rows = db.prepare(`
        SELECT r.id, r.target_pubkey, r.rater_pubkey, r.stars, r.comment, r.role, r.transaction_id, r.created_at,
               m.callsign as target_callsign, m.avatar_url as target_avatar
        FROM ratings r
        LEFT JOIN members m ON r.target_pubkey = m.public_key
        WHERE r.rater_pubkey=?
        ORDER BY r.created_at DESC
    `).all(raterPubkey) as any[];
    return rows.map(r => ({
        id: r.id,
        targetPubkey: r.target_pubkey,
        raterPubkey: r.rater_pubkey,
        stars: r.stars,
        comment: r.comment,
        role: r.role,
        transactionId: r.transaction_id,
        createdAt: r.created_at,
        target_callsign: r.target_callsign,
        target_avatar: r.target_avatar
    }));
}

export function getAverageRating(targetPubkey: string): { average: number; count: number; asProvider: { average: number; count: number }; asReceiver: { average: number; count: number } } {
    const all = db.prepare("SELECT AVG(stars) as avg, COUNT(*) as cnt FROM ratings WHERE target_pubkey=?").get(targetPubkey) as any;
    const prov = db.prepare("SELECT AVG(stars) as avg, COUNT(*) as cnt FROM ratings WHERE target_pubkey=? AND role='provider'").get(targetPubkey) as any;
    const recv = db.prepare("SELECT AVG(stars) as avg, COUNT(*) as cnt FROM ratings WHERE target_pubkey=? AND role='receiver'").get(targetPubkey) as any;

    const round = (val: number) => Math.round((val || 0) * 10) / 10;
    return {
        average: round(all.avg), count: all.cnt || 0,
        asProvider: { average: round(prov.avg), count: prov.cnt || 0 },
        asReceiver: { average: round(recv.avg), count: recv.cnt || 0 }
    };
}

// ===================== FRIENDS & GUARDIANS =====================

export function getFriends(pubkey: string): FriendEntry[] {
    const rows = db.prepare(`SELECT f.friend_pubkey, m.callsign, f.added_at, f.is_guardian FROM friends f JOIN members m ON f.friend_pubkey = m.public_key WHERE f.owner_pubkey=?`).all(pubkey) as any[];
    return rows.map(r => ({ publicKey: r.friend_pubkey, callsign: r.callsign, addedAt: r.added_at, isGuardian: Boolean(r.is_guardian) }));
}

export function addFriend(ownerPubkey: string, friendPubkey: string): FriendEntry | null {
    if (!getMember(ownerPubkey) || !getMember(friendPubkey) || ownerPubkey === friendPubkey) return null;
    
    // UPSERT ignore logic
    const exists = db.prepare("SELECT * FROM friends WHERE owner_pubkey=? AND friend_pubkey=?").get(ownerPubkey, friendPubkey);
    if (!exists) {
        db.prepare("INSERT INTO friends (owner_pubkey, friend_pubkey, added_at) VALUES (?, ?, ?)").run(ownerPubkey, friendPubkey, new Date().toISOString());
    }
    return getFriends(ownerPubkey).find(f => f.publicKey === friendPubkey) || null;
}

export function removeFriend(ownerPubkey: string, friendPubkey: string): boolean {
    const res = db.prepare("DELETE FROM friends WHERE owner_pubkey=? AND friend_pubkey=?").run(ownerPubkey, friendPubkey);
    if (res.changes > 0) {
        writeTombstone('friends', `${ownerPubkey}|${friendPubkey}`);
    }
    return res.changes > 0;
}

export function setGuardian(ownerPubkey: string, friendPubkey: string, isGuardian: boolean): boolean {
    if (!getMember(ownerPubkey) || !getMember(friendPubkey) || ownerPubkey === friendPubkey) return false;
    
    // Ensure the friend entry exists first
    const exists = db.prepare("SELECT * FROM friends WHERE owner_pubkey=? AND friend_pubkey=?").get(ownerPubkey, friendPubkey);
    if (!exists) {
        db.prepare("INSERT INTO friends (owner_pubkey, friend_pubkey, added_at) VALUES (?, ?, ?)").run(ownerPubkey, friendPubkey, new Date().toISOString());
    }

    const res = db.prepare("UPDATE friends SET is_guardian=? WHERE owner_pubkey=? AND friend_pubkey=?").run(isGuardian ? 1 : 0, ownerPubkey, friendPubkey);
    return res.changes > 0;
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
    let deleted = 0;
    db.transaction(() => {
        for (const id of postIds) {
            try {
                adminDeletePost(id);
                deleted++;
            } catch (e) {
                console.error(`Failed to delete post ${id}:`, e);
            }
        }
    })();
    return deleted;
}

export function getPostCount(filter?: { type?: string; category?: string; status?: string; query?: string }): number {
    let query = `SELECT COUNT(*) as c FROM posts WHERE active = 1 AND status NOT IN ('cancelled')`;
    const params: any[] = [];
    if (filter?.type && filter.type !== 'all') { query += " AND type = ?"; params.push(filter.type); }
    if (filter?.category && filter.category !== 'all') { query += " AND category = ?"; params.push(filter.category); }
    if (filter?.status) { query += " AND status = ?"; params.push(filter.status); }
    return (db.prepare(query).get(...params) as any).c;
}

// ===================== COMMUNITY HEALTH =====================

export interface HealthFlag { type: 'wash_trading' | 'isolated_branch' | 'inactive_member' | 'invite_spam' | 'sybil_funnel' | 'sybil_ring' | 'aggregate_spike' | 'cohort_velocity' | 'delinquency'; severity: 'warning' | 'alert' | 'critical'; description: string; members: string[]; }
export interface CommunityHealth { nodeName: string; version: string; minAppVersion: string; currency: { type: string; value: string }; tree: any; activity: any; flags: HealthFlag[]; reportCount: number; }

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
        reportCount
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
    db.transaction(() => {
        // Find existing pending transactions to refund escrow
        const pending = db.prepare("SELECT * FROM marketplace_transactions WHERE post_id=? AND status='pending'").all(postId) as any[];
        for (const tx of pending) {
            transfer(`escrow_${tx.id}`, tx.buyer_pubkey, tx.credits, `Escrow refund for removed post`, 'escrow', true);
            db.prepare("UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(tx.id);
        }
        db.prepare("UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND status='requested'").run(postId);
        db.prepare("UPDATE posts SET active=0, status='cancelled', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(postId);
    })();
    broadcast({ type: 'post_removed', id: postId });
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
}

export function adminSendMessage(targetPubkey: string, body: string) {
    const adminPubkey = getAdminPubkey();
    const conv = createConversation('dm', [adminPubkey, targetPubkey], adminPubkey);
    if (conv) sendMessage(conv.id, adminPubkey, Buffer.from(body, 'utf-8').toString('base64'), 'plaintext-v1');
}

export function migrateAdminConversations() {} // Deprecated, state is clean now.

// ===================== ACTIVITY =====================

export function recordActivity(publicKey: string) {
    db.prepare("UPDATE members SET last_active_at=? WHERE public_key=?").run(new Date().toISOString(), publicKey);
}

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
    const members = getAllMembers();
    const projects = getProjects();
    const commonsBalance = getCommonsBalance();
    
    // ⚡ Bolt: Build a Map for O(1) lookups instead of using .find() in a loop, avoiding O(N^2) complexity.
    const membersByPubKey = new Map(members.map(m => [m.publicKey, m]));

    let balancesCsv = 'Account,Callsign,Balance_Type,Balance\n';
    balancesCsv += `commons,Community Pool,System,${commonsBalance}\n`;
    
    for (const m of members) {
        const bal = getBalance(m.publicKey).balance;
        balancesCsv += `${m.publicKey},${m.callsign},Member,${bal}\n`;
    }
    
    for (const p of projects) {
        if (p.status === 'funded') {
            balancesCsv += `project_${p.id},Project: ${p.title.replace(/,/g, '')},Project_Funded,${p.requestedAmount}\n`;
        }
    }
    
    const pendingTxs = db.prepare("SELECT * FROM marketplace_transactions WHERE status='pending'").all() as any[];
    for (const tx of pendingTxs) {
        const buyer = membersByPubKey.get(tx.buyer_pubkey);
        balancesCsv += `escrow_${tx.id},Escrow (Payer: ${buyer?.callsign || 'Unknown'}),Pending_Trade,${tx.credits}\n`;
    }
    
    let transactionsCsv = 'Timestamp,Transaction_ID,From_Account,To_Account,Amount,Memo\n';
    const txHistory = db.prepare("SELECT * FROM transactions ORDER BY timestamp ASC").all() as any[];
    for (const tx of txHistory) {
         const memoSafe = (tx.memo || '').replace(/,/g, ';').replace(/\n/g, ' ').replace(/\r/g, '');
         transactionsCsv += `${tx.timestamp},${tx.id},${tx.from_pubkey},${tx.to_pubkey},${tx.amount},${memoSafe}\n`;
    }
    
    return { balancesCsv, transactionsCsv };
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
    const rounded = Math.round(COMMONS_BALANCE * 100) / 100;
    db.prepare("INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES ('COMMONS_POOL', ?, 0)").run(rounded);
}

/**
 * Persist demurrage decay events as ledger transaction rows (account → COMMONS_POOL).
 * Decay is applied lazily in-memory by LedgerManager; without these rows the
 * transaction history can never reconcile to account balances, making demurrage
 * invisible to audits. Also syncs the decayed balances/epochs back to the accounts table.
 */
export function persistDecayEvents(): void {
    const events = ledger.drainDecayEvents();
    if (events.length === 0) return;
    // Deterministic id (account + epoch range): if two mesh nodes lazily apply the
    // same logical decay, both generate the same row id and INSERT OR IGNORE dedupes
    // it during replication instead of double-counting the decay in history.
    const insertTxn = db.prepare(`INSERT OR IGNORE INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES (?, ?, 'COMMONS_POOL', ?, 0, ?, ?)`);
    const updateAcc = db.prepare(`UPDATE accounts SET balance=?, last_demurrage_epoch=?, last_updated_at=? WHERE public_key=?`);
    db.transaction(() => {
        for (const ev of events) {
            const id = `demurrage_${ev.accountId.slice(0, 16)}_${ev.toEpoch - ev.epochsPassed}_${ev.toEpoch}`;
            insertTxn.run(id, ev.accountId, Math.round(ev.amount * 10000) / 10000, `Circulation fee (demurrage, ${ev.epochsPassed}d)`, ev.timestamp);
            const acc = ledger.getAccount(ev.accountId);
            updateAcc.run(acc.balance, acc.lastDemurrageEpoch, new Date().toISOString(), ev.accountId);
        }
    })();
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
    persistDecayEvents();
    persistCommonsBalance();

    const sumBalances = (db.prepare(`SELECT COALESCE(SUM(balance), 0) as s FROM accounts`).get() as any).s as number;

    const baselineRow = db.prepare(`SELECT value FROM node_config WHERE key='ledger_audit_baseline'`).get() as any;
    let baseline = baselineRow ? Number(baselineRow.value) : NaN;
    if (!Number.isFinite(baseline)) {
        baseline = sumBalances;
        db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('ledger_audit_baseline', ?)`).run(String(sumBalances));
        console.log(`📐 [LedgerAudit] Baseline established: sum(balances) = ${sumBalances.toFixed(4)}`);
    }
    const drift = sumBalances - baseline;

    const strandedEscrows = (db.prepare(`
        SELECT COUNT(*) as c FROM accounts
        WHERE public_key LIKE 'escrow_%' AND ABS(balance) > 0.01
          AND SUBSTR(public_key, 8) NOT IN (SELECT id FROM marketplace_transactions WHERE status IN ('pending', 'requested'))
    `).get() as any).c as number;

    const ok = Math.abs(drift) < 0.01 && strandedEscrows === 0;
    if (!ok) {
        console.warn(`⚠️ [LedgerAudit] FAILED — sum=${sumBalances.toFixed(4)}, drift=${drift.toFixed(4)} from baseline, stranded escrows=${strandedEscrows}`);
    } else {
        console.log(`✅ [LedgerAudit] OK — sum(balances)=${sumBalances.toFixed(4)}, drift=${drift.toFixed(4)}`);
    }
    return { sumBalances, baseline, drift, strandedEscrows, ok };
}

export function runWashSybilMetricsAudit(): { totalNegative: number; accountsNearFloor: number; delinquentCount: number; cohortAnomalies: number } {
    console.log('📊 [MetricsAudit] Running Wash Trading & Sybil metrics audit...');

    // 1. Total negative balance
    const totalNegativeRow = db.prepare(`SELECT ABS(SUM(balance)) as s FROM accounts WHERE balance < 0`).get() as any;
    const totalNegative = totalNegativeRow ? (totalNegativeRow.s || 0) : 0;

    // 2. Count of accounts near floor & Delinquent accounts
    let accountsNearFloor = 0;
    let delinquentCount = 0;
    try {
        const activeMembers = db.prepare("SELECT public_key FROM members WHERE status = 'active'").all() as { public_key: string }[];
        for (const member of activeMembers) {
            const { floor } = getMemberTrustProfile(member.public_key);
            if (floor < 0) {
                const bal = ledger.getAccount(member.public_key).balance;
                if (bal < 0) {
                    // Near floor: balance within 10 beans of floor
                    if (bal - floor <= 10) {
                        accountsNearFloor++;
                    }
                    // Delinquent: balance <= floor * 0.8 AND no transaction in 7 days
                    if (bal <= floor * 0.8) {
                        const txRow = db.prepare(`
                            SELECT 1 FROM transactions 
                            WHERE (from_pubkey = ? OR to_pubkey = ?) 
                              AND timestamp > datetime('now', '-7 days')
                            LIMIT 1
                        `).get(member.public_key, member.public_key);
                        if (!txRow) {
                            delinquentCount++;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('[MetricsAudit] Failed to compute near-floor/delinquent stats:', e);
    }

    // 3. Cohort Velocity Report
    let cohortAnomalies = 0;
    try {
        const cohorts = db.prepare(`
            SELECT strftime('%Y-%W', joined_at) as cohort_week, GROUP_CONCAT(public_key) as keys
            FROM members
            WHERE joined_at IS NOT NULL AND status = 'active' AND invited_by IS NOT 'genesis'
            GROUP BY cohort_week
        `).all() as { cohort_week: string; keys: string }[];

        for (const c of cohorts) {
            const keys = c.keys.split(',');
            if (keys.length === 0) continue;

            let fastGrowingCount = 0;
            for (const key of keys) {
                const { floor } = getMemberTrustProfile(key);
                if (floor <= -600) {
                    const memberRow = db.prepare("SELECT joined_at FROM members WHERE public_key = ?").get(key) as any;
                    if (memberRow?.joined_at) {
                        const joined = new Date(memberRow.joined_at);
                        const ageDays = (Date.now() - joined.getTime()) / (1000 * 60 * 60 * 24);
                        if (ageDays < 14) {
                            fastGrowingCount++;
                        }
                    }
                }
            }

            const ratio = fastGrowingCount / keys.length;
            if (keys.length >= 2 && ratio >= 0.5) {
                cohortAnomalies++;
            }
        }
    } catch (e) {
        console.error('[MetricsAudit] Failed to compute cohort velocity anomalies:', e);
    }

    // 4. Persist to database system_metrics
    try {
        db.prepare("INSERT INTO system_metrics (metric_key, metric_value) VALUES (?, ?)").run('total_negative_balance', totalNegative);
        db.prepare("INSERT INTO system_metrics (metric_key, metric_value) VALUES (?, ?)").run('accounts_near_floor', accountsNearFloor);
        db.prepare("INSERT INTO system_metrics (metric_key, metric_value) VALUES (?, ?)").run('delinquent_accounts', delinquentCount);
        db.prepare("INSERT INTO system_metrics (metric_key, metric_value) VALUES (?, ?)").run('cohort_anomalies', cohortAnomalies);
        console.log(`✅ [MetricsAudit] Metrics saved: negative_bal=${totalNegative.toFixed(2)}, near_floor=${accountsNearFloor}, delinquent=${delinquentCount}, cohort_anomalies=${cohortAnomalies}`);
    } catch (e) {
        console.error('[MetricsAudit] Failed to persist system metrics:', e);
    }

    return { totalNegative, accountsNearFloor, delinquentCount, cohortAnomalies };
}

export interface ReplicaConsistency {
    checkedAt: string;
    snapshotGeneratedAt: string | null;
    tables: { name: string; primary: number; backup: number; match: boolean }[];
    sumBalances: { primary: number; backup: number; match: boolean };
    commons: { primary: number; backup: number; match: boolean } | null;
    ok: boolean;
}

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
    const count = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as any).c) || 0;
    const round2 = (n: number) => Math.round(n * 100) / 100;

    // exportSyncState dumps each of these tables with an unfiltered SELECT *, so the
    // primary's array length equals a raw COUNT(*) here once the import has applied.
    const tableDefs: [string, number][] = [
        ['members', payload.members?.length ?? 0],
        ['accounts', payload.accounts?.length ?? 0],
        ['transactions', payload.transactions?.length ?? 0],
        ['posts', payload.posts?.length ?? 0],
        ['marketplace_transactions', payload.marketplaceTransactions?.length ?? 0],
        ['messages', payload.messages?.length ?? 0],
    ];
    const tables = tableDefs.map(([name, primary]) => {
        const backup = count(name);
        return { name, primary, backup, match: primary === backup };
    });

    const primarySum = round2((payload.accounts ?? []).reduce((s, a) => s + (Number(a.balance) || 0), 0));
    const backupSum = round2(Number((db.prepare(`SELECT COALESCE(SUM(balance), 0) AS s FROM accounts`).get() as any).s) || 0);
    const sumBalances = { primary: primarySum, backup: backupSum, match: Math.abs(primarySum - backupSum) < 0.01 };

    let commons: ReplicaConsistency['commons'] = null;
    if (typeof payload.commonsBalance === 'number') {
        const primaryC = round2(payload.commonsBalance);
        const backupC = round2(COMMONS_BALANCE);
        commons = { primary: primaryC, backup: backupC, match: Math.abs(primaryC - backupC) < 0.01 };
    }

    const ok = tables.every(t => t.match) && sumBalances.match && (commons ? commons.match : true);
    return {
        checkedAt: new Date().toISOString(),
        snapshotGeneratedAt: payload.generatedAt ?? null,
        tables, sumBalances, commons, ok,
    };
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
    console.log('\n════════════════════════════════════════════════════════');
    console.log('🔁 FAILOVER PROMOTION — running ledger conservation sanity check');
    console.log('════════════════════════════════════════════════════════');
    const result = runLedgerAudit();
    if (result.ok) {
        console.log('✅ PROMOTION OK — replicated ledger is conservation-consistent. Safe to take live writes.');
    } else {
        console.error('🛑 PROMOTION WARNING — ledger conservation check FAILED on the replica:');
        console.error(`   sum(balances)=${result.sumBalances.toFixed(4)} drift=${result.drift.toFixed(4)} stranded escrows=${result.strandedEscrows}`);
        console.error('   Investigate before this node accepts transactions — the last snapshot may be incomplete/corrupt.');
    }
    console.log('════════════════════════════════════════════════════════\n');
    return result;
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

    const notificationMap: Record<SystemMessageType, { title: string; body: string; data: any }> = {
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
        meta.actorPubkey,
        notification.title,
        notification.body,
        notification.data,
        'escrow'
    );
}
