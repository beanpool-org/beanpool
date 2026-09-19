// Stateful messaging mutations, conversation management & system event injection.
//
// Extracted from apps/server/src/state-engine.ts.

import { isSyntheticAccount } from '@beanpool/core';
import { db } from '../db/db.js';
import crypto from 'node:crypto';
import {
    getMember,
    getConversation,
    SystemMessageType,
    type Conversation,
    type Message,
    type SystemMessageTypeVal,
    type TypedMessagePayload
} from '@beanpool/engine';
import {
    GROUP_THREAD_TYPE, GROUP_CHAT_EDIT_ERROR, GROUP_CHAT_REACT_ERROR, GROUP_CHAT_FORBIDDEN, GROUP_CHAT_OBSERVER,
    GROUP_NOT_FOUND, postGroupThreadMessageFromSendRoute,
} from './group-thread.js';
import { unmutedRecipients } from './chat-mutes.js';

type BroadcastFn = (event: any, recipients?: string[]) => void;
type PushFn = (targetPubkeys: string[], actorPubkey: string, title: string, body: string, data: Record<string, any>, categoryId: 'chat' | 'marketplace' | 'escrow') => void;
type RegisterVisitorFn = (pubkey: string) => void;

export interface MessagingCallbacks {
    broadcast: BroadcastFn;
    dispatchPushNotification: PushFn;
    registerVisitor?: RegisterVisitorFn;
}

/**
 * An expected refusal: bad input, or a member not allowed to do this. Routes answer these with `status` (4xx)
 * and the message. Anything else thrown from a messaging path is a server fault (a locked database, a driver
 * error) and must surface as 5xx, so clients retry instead of dropping the message (#672).
 */
export class MessagingError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status = 400, code?: string) {
        super(message);
        this.name = 'MessagingError';
        this.status = status;
        this.code = code;
    }
}

function assertMemberActive(publicKey: string): void {
    if (isSyntheticAccount(publicKey) || publicKey.toLowerCase() === 'system') return;
    const member = db.prepare("SELECT status FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member) throw new MessagingError('Member not found');
    if (member.status === 'disabled') throw new MessagingError('Account is disabled');
    if (member.status === 'pruned') throw new MessagingError('Account has been pruned');
}

/**
 * The old chat group ("👥 Group" in the web app's Talk screen) was removed on 2026-09-19 (groups decision 2):
 * a group chat is now the chat every Commons group owns (engine/group-thread.ts). The create route answers
 * any other type with this, as a 410.
 */
export const CHAT_GROUP_REMOVED_ERROR =
    'Group chats made from Talk were removed. Create a group in Commons instead — every group has its own chat.';

export function createConversation(
    cb: MessagingCallbacks,
    type: 'dm',
    participants: string[],
    createdBy: string,
    name?: string
): Conversation | null {
    if (type !== 'dm') throw new MessagingError(CHAT_GROUP_REMOVED_ERROR, 410);
    if (participants.length !== 2) throw new MessagingError('DM conversations must have exactly 2 distinct participants');
    assertMemberActive(createdBy);
    if (cb.registerVisitor) {
        for (const p of participants) {
            if (!getMember(db, p)) cb.registerVisitor(p);
        }
    }

    // One DM per pair, never keyed to a post (chat consolidation).
    const existing = db.prepare(`
        SELECT c.* FROM conversations c
        JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.public_key = ?
        JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.public_key = ?
        WHERE c.type = 'dm' AND c.post_id IS NULL
    `).get(participants[0], participants[1]) as any;
    if (existing) {
        const parts = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(existing.id) as any[];
        return {
            id: existing.id,
            type: existing.type,
            postId: existing.post_id,
            name: existing.name,
            createdBy: existing.created_by,
            createdAt: existing.created_at,
            participants: parts.map(p => p.public_key)
        };
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    db.transaction(() => {
        db.prepare(`INSERT INTO conversations (id, type, post_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, type, null, name || null, createdBy, createdAt);
        const insertPart = db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)`);
        for (const p of participants) insertPart.run(id, p);
    })();

    const conv: Conversation = { id, type, name: name || null, createdBy, createdAt, participants };
    // A DM's existence says who is talking to whom: only its two participants hear of it.
    cb.broadcast({ type: 'conversation_created', conversation: conv }, participants);
    return conv;
}

export function sendMessage(
    cb: MessagingCallbacks,
    conversationId: string,
    authorPubkey: string,
    ciphertext: string,
    nonce: string,
    type: 'text' | 'image' = 'text',
    attachment?: { data: string; nonce: string; mime?: string },
    metadata?: string,
    clientId?: string
): Message | null {
    assertMemberActive(authorPubkey);
    // A group's chat has one rule book (engine/group-thread.ts): membership re-checked against the group, not
    // the participants mirror; observers read only; 2000 characters; plaintext-v1. Every app already in the
    // stores sends a group chat line through this route, so it is accepted here under exactly those rules.
    const directConv = db.prepare("SELECT type FROM conversations WHERE id=?").get(conversationId) as any;
    if (directConv?.type === GROUP_THREAD_TYPE) {
        try {
            const m = postGroupThreadMessageFromSendRoute(cb, conversationId, authorPubkey, ciphertext, nonce, type, !!attachment?.data, clientId);
            return { id: m.id, conversationId: m.conversationId, authorPubkey: m.authorPubkey, ciphertext: m.ciphertext, nonce: m.nonce, type: m.type, metadata: m.metadata, timestamp: m.timestamp };
        } catch (e: any) {
            throw toGroupChatMessagingError(e);
        }
    }
    // An enterprise thread is written only through its own route (engine/enterprise-thread.ts), which applies
    // the read-only state after wind-up, the frozen-author block, the 2000-character cap and plaintext text
    // only. No participant row is authority to post here (PR #924 review, B1).
    if (directConv?.type === 'enterprise_thread') throw new MessagingError(ENTERPRISE_THREAD_SEND_ERROR, 403);
    let effectiveConvId = conversationId;
    let participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(effectiveConvId) as any[];
    
    // If not found directly, check if conversationId was consolidated into an active DM
    if (!participants.length || !participants.find(p => p.public_key === authorPubkey)) {
        try {
            // json_valid() guards json_extract via CASE so a single row with malformed
            // metadata cannot abort the whole SELECT (which the surrounding catch would
            // then swallow, silently disabling consolidation resolution node-wide).
            const consolidatedMsg = db.prepare(`
                SELECT conversation_id FROM messages
                WHERE metadata IS NOT NULL
                  AND CASE WHEN json_valid(metadata) THEN (
                        json_extract(metadata, '$.originalConversationId') = ?
                        OR json_extract(metadata, '$.originalConversationIds') LIKE ?
                      ) ELSE 0 END
                LIMIT 1
            `).get(conversationId, `%${conversationId}%`) as any;
            if (consolidatedMsg?.conversation_id) {
                effectiveConvId = consolidatedMsg.conversation_id;
                participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(effectiveConvId) as any[];

                // Preserve the ORIGINAL conversation id the sender encrypted against.
                // DM ciphertext is XChaCha20-Poly1305 with the conversationId as AEAD
                // associated data (apps/*/e2e-crypto.ts), so a recipient reading the
                // message under effectiveConvId can only decrypt by retrying with the
                // original id — which the client fallback finds in metadata.originalConversationId.
                // Without this, remapped messages are permanently undecryptable.
                try {
                    const metaObj = metadata ? JSON.parse(metadata) : {};
                    if (!metaObj.originalConversationId) {
                        metaObj.originalConversationId = conversationId;
                        metadata = JSON.stringify(metaObj);
                    }
                } catch {
                    metadata = JSON.stringify({ originalConversationId: conversationId });
                }
            }
        } catch (e) {}
    }

    if (!participants.length || !participants.find(p => p.public_key === authorPubkey)) return null;

    // An event chat is written through POST /api/marketplace/posts/:id/chat/message, which re-checks the
    // RSVP, applies the 2000-character cap and refuses once the event has ended or been cancelled. The
    // participants mirror alone is not authority to post (docs/events-on-the-map.md §2.2).
    const targetConv = db.prepare("SELECT type FROM conversations WHERE id=?").get(effectiveConvId) as any;
    if (targetConv?.type === 'event_thread') throw new MessagingError(EVENT_THREAD_SEND_ERROR, 403);
    if (targetConv?.type === 'enterprise_thread') throw new MessagingError(ENTERPRISE_THREAD_SEND_ERROR, 403);

    if (clientId) {
        const existing = db.prepare("SELECT * FROM messages WHERE id=?").get(clientId) as any;
        if (existing) {
            if (existing.author_pubkey === authorPubkey && existing.conversation_id === effectiveConvId) {
                return {
                    id: existing.id,
                    conversationId: existing.conversation_id,
                    authorPubkey: existing.author_pubkey,
                    ciphertext: existing.ciphertext,
                    nonce: existing.nonce,
                    type: existing.type,
                    metadata: existing.metadata,
                    timestamp: existing.timestamp
                };
            }
            throw new MessagingError('Message id already exists', 409, 'ID_CONFLICT');
        }
    }

    const msg: Message = {
        id: clientId || crypto.randomUUID(),
        conversationId: effectiveConvId,
        authorPubkey,
        ciphertext,
        nonce,
        type,
        metadata,
        timestamp: new Date().toISOString()
    };
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(msg.id, msg.conversationId, msg.authorPubkey, msg.ciphertext, msg.nonce, msg.type, msg.metadata, msg.timestamp);
    
    if (attachment?.data && attachment?.nonce) {
        db.prepare(`INSERT INTO message_attachments (message_id, data, nonce, mime) VALUES (?, ?, ?, ?)`).run(msg.id, attachment.data, attachment.nonce, attachment.mime || 'image/jpeg');
    }

    // Only the conversation's participants — the people GET /api/messages/:id lets read it.
    cb.broadcast({ type: 'new_message', conversationId: effectiveConvId, message: msg, participants: participants.map(p => p.public_key) }, participants.map(p => p.public_key));

    // Node-readable threads never push per message; a DM does, unless the recipient muted it (decision 12).
    if (targetConv?.type !== 'enterprise_thread' && targetConv?.type !== 'event_thread') {
        const senderMember = getMember(db, authorPubkey) as any;
        const senderName = senderMember?.callsign || authorPubkey.slice(0, 8);
        cb.dispatchPushNotification(
            unmutedRecipients(effectiveConvId, participants.map(p => p.public_key)),
            authorPubkey,
            '💬 New Message',
            `${senderName} sent you a message`,
            { screen: 'chat', conversationId: effectiveConvId },
            'chat'
        );
    }

    return msg;
}

export function toggleMessageReaction(
    cb: MessagingCallbacks,
    messageId: string,
    authorPubkey: string,
    emoji: string
): any {
    const row = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId) as any;
    if (!row) return null;

    // An enterprise thread has no reactions, and nobody's participant row there is authority to write (B1).
    // Refused before the participant check: the thread is readable by members, so this hides nothing.
    const convType = db.prepare("SELECT type FROM conversations WHERE id=?").get(row.conversation_id) as any;
    if (convType?.type === 'enterprise_thread') throw new MessagingError(ENTERPRISE_THREAD_REACT_ERROR, 403);

    const participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(row.conversation_id) as any[];
    if (!participants.some((p: any) => p.public_key === authorPubkey)) {
        return null;
    }

    // An event chat carries text the host can remove and nothing else, and it is read-only once the event
    // ends — a reaction would be a write this route cannot rule on.
    if (convType?.type === 'event_thread') throw new MessagingError(EVENT_THREAD_REACT_ERROR, 403);
    // A group chat carries text and system lines only in this slice; reactions come with the chat features.
    if (convType?.type === GROUP_THREAD_TYPE) throw new MessagingError(GROUP_CHAT_REACT_ERROR, 403);

    let metadata: any = {};
    if (row.metadata) {
        try {
            metadata = JSON.parse(row.metadata);
        } catch {
            metadata = {};
        }
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        metadata = {};
    }

    if (!Array.isArray(metadata.reactions)) {
        metadata.reactions = [];
    }

    const existingIndex = metadata.reactions.findIndex((r: any) => r.author === authorPubkey);
    if (existingIndex > -1) {
        const existingReaction = metadata.reactions[existingIndex];
        if (existingReaction.emoji === emoji) {
            metadata.reactions.splice(existingIndex, 1);
        } else {
            metadata.reactions[existingIndex].emoji = emoji;
        }
    } else {
        metadata.reactions.push({ emoji, author: authorPubkey });
    }

    const metadataStr = JSON.stringify(metadata);
    db.prepare("UPDATE messages SET metadata=? WHERE id=?").run(metadataStr, messageId);

    cb.broadcast({
        type: 'message_reaction',
        conversationId: row.conversation_id,
        messageId,
        metadata: metadataStr,
        participants: participants.map(p => p.public_key)
    }, participants.map(p => p.public_key));

    return { success: true, metadata: metadataStr };
}

export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;
export const MESSAGE_REMOVED_EDIT_ERROR = 'A message removed by a keeper cannot be edited';
export const THREAD_MESSAGE_EDIT_ERROR = 'Messages in an enterprise discussion thread cannot be edited';
export const EVENT_THREAD_EDIT_ERROR = 'Messages in an event chat cannot be edited';
export const EVENT_THREAD_SEND_ERROR = 'Post to an event chat through the event, not this route';
export const EVENT_THREAD_REACT_ERROR = 'Reactions are not part of an event chat';
export const ENTERPRISE_THREAD_SEND_ERROR = "Post to an enterprise's discussion through the enterprise, not this route";
export const ENTERPRISE_THREAD_REACT_ERROR = 'Reactions are not part of an enterprise discussion';

export function editMessage(
    cb: MessagingCallbacks,
    messageId: string,
    authorPubkey: string,
    ciphertext: string,
    nonce: string
): Message {
    assertMemberActive(authorPubkey);
    const row = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId) as any;
    if (!row) throw new MessagingError('Message not found');
    if (row.author_pubkey !== authorPubkey) throw new MessagingError('Only the author can edit a message');
    if (row.type === 'system') throw new MessagingError('System messages cannot be edited');
    // A keeper-removed message is a tombstone: never editable, by any route.
    if (row.type === 'removed') throw new MessagingError(MESSAGE_REMOVED_EDIT_ERROR, 403);
    // Enterprise discussion-thread messages are not editable. This route has no size bound
    // and knows nothing of thread moderation or a wound-up enterprise's read-only thread.
    // Fails closed: a message whose conversation row is missing cannot be shown to be outside a thread.
    const conv = db.prepare("SELECT type FROM conversations WHERE id=?").get(row.conversation_id) as any;
    if (!conv) throw new MessagingError('Conversation not found', 404);
    if (conv.type === 'enterprise_thread') throw new MessagingError(THREAD_MESSAGE_EDIT_ERROR, 403);
    // An event chat is moderated by its host and goes read-only when the event ends; this route knows
    // neither, so it refuses (docs/events-on-the-map.md §2.2).
    if (conv.type === 'event_thread') throw new MessagingError(EVENT_THREAD_EDIT_ERROR, 403);
    // A group chat is moderated by its convenors; this route has no size bound and no membership re-check.
    if (conv.type === GROUP_THREAD_TYPE) throw new MessagingError(GROUP_CHAT_EDIT_ERROR, 403);

    const sentAtMs = new Date(row.timestamp).getTime();
    if (Number.isNaN(sentAtMs) || Date.now() - sentAtMs > MESSAGE_EDIT_WINDOW_MS) {
        throw new MessagingError('Messages can only be edited within 15 minutes of sending');
    }

    const editedAt = new Date().toISOString();
    db.prepare("UPDATE messages SET ciphertext=?, nonce=?, edited_at=? WHERE id=?").run(ciphertext, nonce, editedAt, messageId);

    const updated: Message = {
        id: row.id,
        conversationId: row.conversation_id,
        authorPubkey: row.author_pubkey,
        ciphertext,
        nonce,
        type: row.type,
        systemType: row.system_type,
        metadata: row.metadata,
        timestamp: row.timestamp,
        editedAt
    };

    const participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(row.conversation_id) as any[];
    cb.broadcast({
        type: 'message_edited',
        conversationId: row.conversation_id,
        message: updated,
        participants: participants.map(p => p.public_key)
    }, participants.map(p => p.public_key));

    return updated;
}

export function injectSystemMessage(
    cb: MessagingCallbacks,
    postId: string,
    type: SystemMessageTypeVal | string,
    meta: TypedMessagePayload,
    buyerPubkey?: string,
    sellerPubkey?: string
): void {
    let convRows: any[];
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

    const contentMap: Record<string, string> = {
        [SystemMessageType.ESCROW_FUNDED]: `${meta.amount} Beans placed in escrow.`,
        [SystemMessageType.ESCROW_RELEASED]: `Payment of ${meta.amount} Beans released to the provider.`,
        [SystemMessageType.ESCROW_CANCELLED]: `Escrow cancelled and funds refunded.`,
        [SystemMessageType.COMMONS_GRANT]: `Commons grant awarded.`,
        [SystemMessageType.VOUCH_GRANTED]: `Vouch granted.`,
        [SystemMessageType.VOUCH_REVOKED]: `Vouch revoked.`,
        [SystemMessageType.ESCROW_DISPUTE_RESOLVED]: `Dispute arbitrated by admin (${meta.authSigner || 'admin'}): ${
            meta.resolution === 'release_to_seller' ? 'Released to seller' : meta.resolution === 'refund_to_buyer' ? 'Refunded to buyer' : 'Split 50/50'
        }${meta.reason ? ` — ${meta.reason}` : ''}.`
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

        // System lines are plaintext (amounts, rulings): the conversation's participants only.
        cb.broadcast({ type: 'new_message', conversationId, message: msg, participants: participants.map(p => p.public_key) }, participants.map(p => p.public_key));
    }
}

/** Map a group-chat refusal onto the status the ordinary messaging routes answer with. */
function toGroupChatMessagingError(e: any): Error {
    if (e instanceof MessagingError) return e;
    const msg: string = e?.message || 'Could not send the message';
    if (e?.code === 'ID_CONFLICT') return new MessagingError(msg, 409, 'ID_CONFLICT');
    if (msg === GROUP_NOT_FOUND) return new MessagingError(msg, 404);
    if (msg === GROUP_CHAT_FORBIDDEN || msg === GROUP_CHAT_OBSERVER
        || /disabled|suspended|pruned|closed|Frozen|invalidated|Member not found/.test(msg)) return new MessagingError(msg, 403);
    if (/empty|too long|plain text|Only text/.test(msg)) return new MessagingError(msg, 400);
    return e;
}

/**
 * Delete every conversation left from the removed chat-group feature (type 'group', decision 2), with its
 * messages, participants and attachments. Day zero: nothing is migrated and nothing stays readable. Tombstones
 * carry the delete to backups. Primary only, at boot; idempotent.
 */
export function removeOldChatGroups(): number {
    const doomed = db.prepare("SELECT id FROM conversations WHERE type = 'group'").all() as { id: string }[];
    if (doomed.length === 0) return 0;
    db.transaction(() => {
        for (const { id } of doomed) {
            const parts = db.prepare('SELECT public_key FROM conversation_participants WHERE conversation_id = ?').all(id) as any[];
            db.prepare('DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)').run(id);
            db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
            db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ?').run(id);
            db.prepare('DELETE FROM chat_mutes WHERE conversation_id = ?').run(id);
            db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
            for (const p of parts) writeTombstone('conversation_participants', `${id}|${p.public_key}`);
            writeTombstone('conversations', id);
        }
    })();
    console.log(`[Messaging] Removed ${doomed.length} old chat group(s) — the feature was retired (groups decision 2).`);
    return doomed.length;
}

export function markConversationRead(pubkey: string, conversationId: string): void {
    db.prepare(`UPDATE conversation_participants SET last_read_at=? WHERE conversation_id=? AND public_key=?`).run(new Date().toISOString(), conversationId, pubkey);
}

export function ensureTransactionConversation(
    cb: MessagingCallbacks,
    postId: string,
    buyerPubkey: string,
    sellerPubkey: string
): string {
    const conv = createConversation(cb, 'dm', [buyerPubkey, sellerPubkey], buyerPubkey);
    if (!conv) throw new Error('Failed to create transaction conversation');
    return conv.id;
}

function writeTombstone(tableName: string, rowKey: string): void {
    const deletedAt = new Date().toISOString();
    db.prepare(`
        INSERT INTO tombstones (table_name, row_key, deleted_at)
        VALUES (?, ?, ?)
        ON CONFLICT(table_name, row_key) DO UPDATE SET deleted_at = excluded.deleted_at
    `).run(tableName, rowKey, deletedAt);
}

export function migrateConsolidateConversations(cb: MessagingCallbacks): void {
    const postKeyed = db.prepare("SELECT id FROM conversations WHERE post_id IS NOT NULL").all() as any[];
    if (postKeyed.length === 0) return;
    console.log(`[Migration] Consolidating ${postKeyed.length} per-post conversation(s) into per-pair DMs...`);

    db.transaction(() => {
        for (const conv of postKeyed) {
            const parts = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(conv.id) as any[];
            if (parts.length === 2) {
                try {
                    const targetConv = createConversation(cb, 'dm', [parts[0].public_key, parts[1].public_key], parts[0].public_key);
                    if (targetConv) {
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
            
            const msgs = db.prepare("SELECT id, metadata FROM messages WHERE conversation_id = ?").all(dm.id) as any[];
            for (const msg of msgs) {
                let meta: any = {};
                if (msg.metadata) {
                    try {
                        meta = JSON.parse(msg.metadata);
                    } catch (e) {}
                }
                
                if (meta.originalConversationId || meta.originalConversationIds) continue;
                
                if (legacyIds.length === 1) {
                    meta.originalConversationId = legacyIds[0];
                } else {
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
