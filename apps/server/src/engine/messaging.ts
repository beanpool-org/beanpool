// Stateful messaging mutations, conversation management & system event injection.
//
// Extracted from apps/server/src/state-engine.ts.

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

type BroadcastFn = (event: any, recipients?: string[]) => void;
type PushFn = (targetPubkeys: string[], actorPubkey: string, title: string, body: string, data: Record<string, any>, categoryId: 'chat' | 'marketplace' | 'escrow') => void;
type RegisterVisitorFn = (pubkey: string) => void;

export interface MessagingCallbacks {
    broadcast: BroadcastFn;
    dispatchPushNotification: PushFn;
    registerVisitor?: RegisterVisitorFn;
}

function assertMemberActive(publicKey: string): void {
    if (publicKey.startsWith('escrow_') || publicKey.startsWith('project_') || publicKey === 'COMMONS_POOL' || publicKey === 'SYSTEM' || publicKey === 'genesis') return;
    const member = db.prepare("SELECT status FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member) throw new Error('Member not found');
    if (member.status === 'disabled') throw new Error('Account is disabled');
    if (member.status === 'pruned') throw new Error('Account has been pruned');
}

export function createConversation(
    cb: MessagingCallbacks,
    type: 'dm' | 'group',
    participants: string[],
    createdBy: string,
    name?: string,
    postId?: string
): Conversation | null {
    assertMemberActive(createdBy);
    if (cb.registerVisitor) {
        for (const p of participants) {
            if (!getMember(db, p)) cb.registerVisitor(p);
        }
    }

    const effectivePostId = type === 'dm' ? undefined : postId;

    if (type === 'dm' && participants.length === 2) {
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
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    db.transaction(() => {
        db.prepare(`INSERT INTO conversations (id, type, post_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, type, effectivePostId || null, name || null, createdBy, createdAt);
        const insertPart = db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)`);
        for (const p of participants) insertPart.run(id, p);
    })();

    const conv: Conversation = { id, type, postId, name: name || null, createdBy, createdAt, participants };
    cb.broadcast({ type: 'conversation_created', conversation: conv });
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
    const participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(conversationId) as any[];
    if (!participants.length || !participants.find(p => p.public_key === authorPubkey)) return null;

    if (clientId) {
        const existing = db.prepare("SELECT * FROM messages WHERE id=?").get(clientId) as any;
        if (existing) {
            if (existing.author_pubkey === authorPubkey && existing.conversation_id === conversationId) {
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
            throw Object.assign(new Error('Message id already exists'), { code: 'ID_CONFLICT' });
        }
    }

    const msg: Message = {
        id: clientId || crypto.randomUUID(),
        conversationId,
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

    cb.broadcast({ type: 'new_message', conversationId, message: msg, participants: participants.map(p => p.public_key) });

    const senderMember = getMember(db, authorPubkey) as any;
    const senderName = senderMember?.callsign || authorPubkey.slice(0, 8);
    cb.dispatchPushNotification(
        participants.map(p => p.public_key),
        authorPubkey,
        '💬 New Message',
        `${senderName} sent you a message`,
        { screen: 'chat', conversationId },
        'chat'
    );

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
            metadata.reactions.splice(existingIndex, 1);
        } else {
            metadata.reactions[existingIndex].emoji = emoji;
        }
    } else {
        metadata.reactions.push({ emoji, author: authorPubkey });
    }

    const metadataStr = JSON.stringify(metadata);
    db.prepare("UPDATE messages SET metadata=? WHERE id=?").run(metadataStr, messageId);

    const participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(row.conversation_id) as any[];
    cb.broadcast({
        type: 'message_reaction',
        conversationId: row.conversation_id,
        messageId,
        metadata: metadataStr,
        participants: participants.map(p => p.public_key)
    });

    return { success: true, metadata: metadataStr };
}

export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

export function editMessage(
    cb: MessagingCallbacks,
    messageId: string,
    authorPubkey: string,
    ciphertext: string,
    nonce: string
): Message {
    assertMemberActive(authorPubkey);
    const row = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId) as any;
    if (!row) throw new Error('Message not found');
    if (row.author_pubkey !== authorPubkey) throw new Error('Only the author can edit a message');
    if (row.type === 'system') throw new Error('System messages cannot be edited');

    const sentAtMs = new Date(row.timestamp).getTime();
    if (Number.isNaN(sentAtMs) || Date.now() - sentAtMs > MESSAGE_EDIT_WINDOW_MS) {
        throw new Error('Messages can only be edited within 15 minutes of sending');
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
    });

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
        [SystemMessageType.VOUCH_REVOKED]: `Vouch revoked.`
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

        cb.broadcast({ type: 'new_message', conversationId, message: msg, participants: participants.map(p => p.public_key) });
    }
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
