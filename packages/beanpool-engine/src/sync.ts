// Pure database state export, hash generation, and sync payload types.
//
// Extracted from apps/server/src/state-engine.ts.

import type Database from 'better-sqlite3';

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
    reason: string;
    createdAt: string;
    status?: string;
    updatedAt?: string | null;
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
    recoveryRequests?: SyncRecoveryRequest[];
    recoveryApprovals?: SyncRecoveryApproval[];
    tombstones?: { tableName: string; rowKey: string; deletedAt: string }[];
    nodeId: string;
    generatedAt?: string;
    signature?: string;
    publicKey?: string;
}

export function getStateHash(db: Db): string {
    const pKeys = db.prepare("SELECT public_key FROM members ORDER BY public_key").all() as any[];
    const pIds = db.prepare("SELECT id FROM posts WHERE active=1 ORDER BY id").all() as any[];
    const data = JSON.stringify({ m: pKeys.map(k => k.public_key), p: pIds.map(i => i.id) });

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

    const members = (delta
        ? db.prepare("SELECT * FROM members WHERE updated_at >= ?").all(since) as any[]
        : db.prepare("SELECT * FROM members").all() as any[]
    ).map(rowToMember);

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
        isGuardian: Boolean(row.is_guardian),
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
        reason: row.reason,
        createdAt: row.created_at,
        status: row.status || 'pending',
        updatedAt: row.updated_at || row.created_at,
    }));

    const recoveryReqRows = sel('recovery_requests', 'updated_at');
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

    const recoveryAppRows = sel('recovery_approvals', 'created_at');
    const recoveryApprovals: SyncRecoveryApproval[] = recoveryAppRows.map(row => ({
        requestId: row.request_id,
        guardianPubkey: row.guardian_pubkey,
        decision: row.decision,
        createdAt: row.created_at,
    }));

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
        commonsBalance: Math.round(commonsBalance * 100) / 100,
        abuseReports,
        recoveryRequests,
        recoveryApprovals,
        tombstones,
    };
}
