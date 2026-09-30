// Typed Messaging & Conversations pure database queries and types.
//
// Extracted from apps/server/src/state-engine.ts.

import type Database from 'better-sqlite3';
import { avatarUrlFor } from '@beanpool/core';
import { postPhotoUrl } from './photo-url.js';

type Db = Database.Database;

export enum SystemMessageType {
    ESCROW_CREATED = 'ESCROW_CREATED',
    ESCROW_FUNDED = 'ESCROW_FUNDED',
    ESCROW_RELEASED = 'ESCROW_RELEASED',
    ESCROW_CANCELLED = 'ESCROW_CANCELLED',
    DISPUTE_OPENED = 'DISPUTE_OPENED',
    REVIEW_LEFT = 'REVIEW_LEFT',
    COMMONS_GRANT = 'COMMONS_GRANT',
    VOUCH_GRANTED = 'VOUCH_GRANTED',
    VOUCH_REVOKED = 'VOUCH_REVOKED',
    ESCROW_DISPUTE_RESOLVED = 'ESCROW_DISPUTE_RESOLVED'
}

export type SystemMessageTypeVal = SystemMessageType | string;

export interface TypedMessagePayload {
    amount?: number;
    postId?: string;
    actorPubkey?: string;
    buyerPubkey?: string;
    sellerPubkey?: string;
    txHash?: string;
    voucherPubkey?: string;
    targetPubkey?: string;
    vouchLevel?: number;
    creditFloor?: number;
    resolution?: string;
    authSigner?: string;
    /** Who ruled, in words a member reads ("a community admin" or the admin's callsign). */
    resolvedByName?: string;
    reason?: string;
    transactionId?: string;
}

export interface Message {
    id: string;
    conversationId: string;
    authorPubkey: string;
    ciphertext: string;
    nonce: string;
    type: 'text' | 'image' | 'system' | string;
    systemType?: string;
    metadata?: string;
    timestamp: string;
    editedAt?: string | null;
    updatedAt?: string | null;
}

export interface Conversation {
    id: string;
    /**
     * 'dm' (end-to-end encrypted), or a node-readable thread owned by something else: 'group_thread' (a Commons
     * group, id = group id), 'event_thread' (id = event post id), 'enterprise_thread' (id = enterprise pubkey).
     */
    type: 'dm' | 'group_thread' | 'event_thread' | 'enterprise_thread' | string;
    postId?: string;
    postTitle?: string;
    postStatus?: string;
    postPhoto?: string | null;
    lastMsgType?: string;
    lastSysType?: string;
    name?: string | null;
    createdBy: string;
    createdAt: string;
    participants: string[];
    peerCallsign?: string;
    peerAvatar?: string | null;
    peerLastReadAt?: string | null;
    myLastReadAt?: string | null;
    readCursors?: { publicKey: string; lastReadAt: string | null }[];
}

function selectInChunks<T = any>(db: Db, ids: string[], queryBuilder: (placeholders: string) => string, chunkSize = 500): T[] {
    if (ids.length === 0) return [];
    const results: T[] = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db.prepare(queryBuilder(placeholders)).all(...chunk) as T[];
        results.push(...rows);
    }
    return results;
}

export function getConversationsByMember(db: Db, pubkey: string): Conversation[] {
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
        WHERE cp.public_key = ? AND c.type != 'enterprise_thread'
        ORDER BY (m.rowid IS NULL) ASC, m.rowid DESC, c.created_at DESC
    `).all(pubkey) as any[];

    const conversationIds = rows.map(r => r.id);
    const participantsByConv = new Map<string, string[]>();
    const peerLastReadByConv = new Map<string, string | null>();
    const myLastReadByConv = new Map<string, string | null>();
    const allPeerPubkeys = new Set<string>();

    if (conversationIds.length > 0) {
        const allParts = selectInChunks(db, conversationIds, ph => `SELECT conversation_id, public_key, last_read_at FROM conversation_participants WHERE conversation_id IN (${ph})`);

        for (const part of allParts) {
            if (!participantsByConv.has(part.conversation_id)) {
                participantsByConv.set(part.conversation_id, []);
            }
            participantsByConv.get(part.conversation_id)!.push(part.public_key);
            if (part.public_key !== pubkey) {
                allPeerPubkeys.add(part.public_key);
                peerLastReadByConv.set(part.conversation_id, part.last_read_at || null);
            } else {
                myLastReadByConv.set(part.conversation_id, part.last_read_at || null);
            }
        }
    }

    const membersByPubkey = new Map<string, any>();
    if (allPeerPubkeys.size > 0) {
        const pubkeysArray = Array.from(allPeerPubkeys);
        const allMembers = selectInChunks(db, pubkeysArray, ph => `SELECT public_key, callsign, avatar_url FROM members WHERE public_key IN (${ph})`);

        for (const member of allMembers) {
            membersByPubkey.set(member.public_key, member);
        }
    }

    // A chat about a listing shows the listing's first photo, by the URL its listing's photos carry (photo-url.ts: keyed
    // where they are), and only for a listing this member can see (getPosts' audience rule, hidden by reports included):
    // a chat can outlast their place in a group. It read a `posts.photos` column no schema has, so it threw whenever a
    // chat had a listing; every chat is written with none today (createConversation), so none has shown one.
    const postIds = Array.from(new Set(rows.map(r => r.post_id).filter(id => id != null)));
    const postPhotosById = new Map<string, string | null>();
    for (let i = 0; i < postIds.length; i += 500) {
        const chunk = postIds.slice(i, i + 500);
        const firstPhotos = db.prepare(`
            SELECT pp.post_id, pp.order_num, pp.updated_at, p.audience_scope
              FROM post_photos pp JOIN posts p ON p.id = pp.post_id
             WHERE pp.post_id IN (${chunk.map(() => '?').join(',')})
               AND pp.order_num = (SELECT MIN(first.order_num) FROM post_photos first WHERE first.post_id = pp.post_id)
               AND ((p.audience_scope IS NULL OR p.audience_scope = 'public')
                    OR p.author_pubkey = ?
                    OR (p.audience_scope = 'group' AND p.target_group_id IN (SELECT group_id FROM group_members WHERE member_pubkey = ? AND status = 'active'))
                    OR (p.audience_scope = 'direct' AND (p.target_pubkey = ? OR p.assigned_to = ?)))
               AND (p.hidden_by_reports_at IS NULL OR p.author_pubkey = ?)
        `).all(...chunk, pubkey, pubkey, pubkey, pubkey, pubkey) as { post_id: string; order_num: number; updated_at: string | null; audience_scope: string | null }[];
        for (const ph of firstPhotos) postPhotosById.set(ph.post_id, postPhotoUrl(ph.post_id, ph.order_num, ph.updated_at, ph.audience_scope));
    }

    return rows.map(r => {
        const parts = participantsByConv.get(r.id) || [];
        const peerPubkey = parts.find(p => p !== pubkey);
        let peerCallsign: string | undefined;
        let peerAvatar: string | null = null;
        if (peerPubkey) {
            const peerMember = membersByPubkey.get(peerPubkey);
            if (peerMember) {
                peerCallsign = peerMember.callsign;
                peerAvatar = avatarUrlFor(peerMember.public_key, peerMember.avatar_url);
            }
        }

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

export function getConversationMessages(db: Db, conversationId: string, limit = 50, offset = 0): Message[] {
    const rows = db.prepare(`SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(conversationId, limit, offset) as any[];
    return rows.reverse().map(r => ({
        id: r.id,
        conversationId: r.conversation_id,
        authorPubkey: r.author_pubkey,
        ciphertext: r.ciphertext,
        nonce: r.nonce,
        type: r.type,
        systemType: r.system_type,
        metadata: r.metadata,
        timestamp: r.timestamp,
        editedAt: r.edited_at,
        updatedAt: r.updated_at || null
    }));
}

export function getConversation(db: Db, id: string): Conversation | undefined {
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
        readCursors: parts.map(p => ({ publicKey: p.public_key, lastReadAt: p.last_read_at || null }))
    } as any;
}

/**
 * A group chat's membership lines (joined, left, removed, role changed) are shown in the chat but never count
 * as unread — nobody should get a badge because someone joined. The server's group chat
 * (apps/server/src/engine/group-thread.ts, GroupSystemType) writes these kinds.
 */
export const QUIET_SYSTEM_TYPES: readonly string[] = [
    'GROUP_MEMBER_JOINED', 'GROUP_MEMBER_LEFT', 'GROUP_MEMBER_REMOVED', 'GROUP_ROLE_CHANGED',
];
const QUIET_SQL = QUIET_SYSTEM_TYPES.map(t => `'${t}'`).join(', ');

/**
 * SQL predicate on a `messages m` row: true when it counts toward the viewer's unread badge. Not a membership
 * line, and not a system line about something the viewer did themselves (their own event or poll landing in a
 * group chat). Takes ONE bound parameter: the viewer's pubkey.
 */
export const COUNTS_AS_UNREAD_SQL = `NOT (m.type = 'system' AND (
    COALESCE(m.system_type, '') IN (${QUIET_SQL})
    OR COALESCE(CASE WHEN json_valid(m.metadata) THEN json_extract(m.metadata, '$.actorPubkey') END, '') = ?
))`;

export function getUnreadCounts(db: Db, pubkey: string): Record<string, number> {
    const rows = db.prepare(`
        SELECT cp.conversation_id, 
               (SELECT COUNT(*) FROM messages m 
                WHERE m.conversation_id = cp.conversation_id 
                  AND m.author_pubkey != ? 
                  AND (cp.last_read_at IS NULL OR m.timestamp > cp.last_read_at)
                  AND ${COUNTS_AS_UNREAD_SQL}
               ) as unread_count
        FROM conversation_participants cp
        JOIN conversations c ON cp.conversation_id = c.id
        WHERE cp.public_key = ? AND c.type != 'enterprise_thread'
    `).all(pubkey, pubkey, pubkey) as any[];

    const counts: Record<string, number> = {};
    for (const r of rows) if (r.unread_count > 0) counts[r.conversation_id] = r.unread_count;
    return counts;
}
