// Enterprise discussion thread pure operations and lifecycle enforcement (Slice 6).
//
// Docs: docs/the-commons.md §2.2 ("Talking about it") and §9.
// Marty's decision (2026-09-17): thread is its own thing on the enterprise, NOT a group.

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { getMember, getConversation, type Conversation } from '@beanpool/engine';
import { isSyntheticAccount } from '@beanpool/core';
import type { MessagingCallbacks } from './messaging.js';
import { avatarUrlFor } from './avatar-url.js';

export interface EnterpriseThreadMessage {
    id: string;
    conversationId: string;
    authorPubkey: string;
    authorCallsign?: string;
    authorAvatar?: string | null;
    ciphertext: string;
    nonce: string;
    type: 'text' | 'removed' | string;
    metadata?: string;
    timestamp: string;
    editedAt?: string | null;
}

/**
 * A pruned or deleted enterprise is hidden everywhere (its detail read is a 404), so its thread is hidden too.
 */
export function isEnterpriseThreadHidden(status: string | null | undefined): boolean {
    return status === 'pruned' || status === 'deleted';
}

/**
 * A wound-up, suspended or disabled enterprise is still shown, so its thread still reads — but nobody can post.
 * Paused is NOT here: pausing is exactly when people need to talk about it.
 */
export function isEnterpriseThreadReadOnly(status: string | null | undefined): boolean {
    return status === 'completed' || status === 'suspended' || status === 'disabled';
}

export function isKeeperOfEnterprise(actorPubkey: string, enterprisePubkey: string): boolean {
    const cleanKey = typeof actorPubkey === 'string' ? actorPubkey.trim().toLowerCase() : '';
    try {
        const invalidated = db.prepare("SELECT 1 FROM invalidated_keys WHERE public_key = ?").get(cleanKey);
        if (invalidated) return false;
    } catch { }
    const op = db.prepare("SELECT can_operate, status FROM members WHERE public_key = ?").get(actorPubkey) as any;
    if (!op || op.status === 'disabled' || op.status === 'suspended' || op.status === 'pruned') return false;
    if (!op.can_operate) return false;
    const row = db.prepare(
        "SELECT 1 FROM treasury_operators WHERE member_pubkey = ? AND treasury_pubkey = ?"
    ).get(actorPubkey, enterprisePubkey);
    return !!row;
}

/**
 * A keeper's read cursor on the thread, kept in thread_read_cursors and never in conversation_participants: a
 * participant row is what the generic send and react routes take as the right to write (PR #924 review, B1).
 * Made read-up-to-now the first time, so a new keeper is not handed the thread's whole history as unread.
 */
export function ensureKeeperReadCursor(enterprisePubkey: string, keeperPubkey: string): void {
    db.prepare('INSERT OR IGNORE INTO thread_read_cursors (conversation_id, member_pubkey, last_read_at) VALUES (?, ?, ?)')
        .run(enterprisePubkey, keeperPubkey, new Date().toISOString());
}

export function markKeeperThreadRead(enterprisePubkey: string, keeperPubkey: string): void {
    db.prepare(`INSERT INTO thread_read_cursors (conversation_id, member_pubkey, last_read_at) VALUES (?, ?, ?)
                ON CONFLICT(conversation_id, member_pubkey) DO UPDATE SET last_read_at = excluded.last_read_at`)
        .run(enterprisePubkey, keeperPubkey, new Date().toISOString());
}

export function getKeeperReadCursor(enterprisePubkey: string, keeperPubkey: string): { lastReadAt: string; since: string } | null {
    const r = db.prepare('SELECT last_read_at, created_at FROM thread_read_cursors WHERE conversation_id = ? AND member_pubkey = ?')
        .get(enterprisePubkey, keeperPubkey) as any;
    return r ? { lastReadAt: r.last_read_at, since: r.created_at } : null;
}

export function ensureEnterpriseThread(enterprisePubkey: string): Conversation {
    const enterprise = db.prepare(
        "SELECT public_key, callsign, is_treasury, status, paused, joined_at FROM members WHERE public_key = ?"
    ).get(enterprisePubkey) as any;
    if (!enterprise || !enterprise.is_treasury) {
        throw new Error('Enterprise not found');
    }
    let conv = getConversation(db, enterprisePubkey);
    if (!conv) {
        // Now, not joined_at: the delta backup exporter cursors conversations on created_at (#837 review).
        const createdAt = new Date().toISOString();
        db.prepare(`
            INSERT OR IGNORE INTO conversations (id, type, name, created_by, created_at)
            VALUES (?, 'enterprise_thread', ?, ?, ?)
        `).run(enterprisePubkey, enterprise.callsign, enterprisePubkey, createdAt);
        conv = getConversation(db, enterprisePubkey);
    }
    return conv!;
}

export function getEnterpriseThreadMessages(
    enterprisePubkey: string,
    limit = 50,
    offset = 0
): EnterpriseThreadMessage[] {
    ensureEnterpriseThread(enterprisePubkey);
    const rows = db.prepare(`
        SELECT m.*, memb.callsign as author_callsign, memb.avatar_url as author_avatar
        FROM messages m
        LEFT JOIN members memb ON m.author_pubkey = memb.public_key
        WHERE m.conversation_id = ?
        ORDER BY m.timestamp DESC, m.rowid DESC
        LIMIT ? OFFSET ?
    `).all(enterprisePubkey, limit, offset) as any[];

    return rows.reverse().map(r => {
        let displayCiphertext = r.ciphertext;
        if (r.type === 'removed') {
            displayCiphertext = Buffer.from('removed by a keeper', 'utf8').toString('base64');
        }
        return {
            id: r.id,
            conversationId: r.conversation_id,
            authorPubkey: r.author_pubkey,
            authorCallsign: r.author_callsign || r.author_pubkey?.slice(0, 8),
            authorAvatar: avatarUrlFor(r.author_pubkey, r.author_avatar),
            ciphertext: displayCiphertext,
            nonce: r.nonce,
            type: r.type,
            metadata: r.metadata,
            timestamp: r.timestamp,
            editedAt: r.edited_at,
        };
    });
}

/**
 * The author-side block every node-readable thread applies: an invalidated device key, a disabled,
 * suspended, pruned or closed account, or a credit-frozen member cannot post. Shared with the event chat
 * (engine/event-thread.ts) so both threads refuse in exactly the same words, which the routes map to 403.
 */
export function assertThreadMemberCanPost(authorPubkey: string): void {
    if (isSyntheticAccount(authorPubkey) || authorPubkey.toLowerCase() === 'system') return;
    const cleanKey = typeof authorPubkey === 'string' ? authorPubkey.trim().toLowerCase() : '';
    try {
        const invalidated = db.prepare("SELECT reason, rekeyed_to FROM invalidated_keys WHERE public_key = ?").get(cleanKey) as any;
        if (invalidated) {
            const rekeyDetail = invalidated.rekeyed_to ? ` and re-keyed to ${invalidated.rekeyed_to}` : '';
            throw new Error(`Device key has been invalidated (${invalidated.reason}${rekeyDetail}). Please re-enrol using your replacement device.`);
        }
    } catch (e: any) {
        if (e?.message?.includes('Device key has been invalidated')) throw e;
    }
    const member = db.prepare("SELECT status, COALESCE(credit_frozen, 0) as credit_frozen FROM members WHERE public_key = ?").get(cleanKey) as any;
    if (!member) throw new Error('Member not found');
    if (member.status === 'disabled') throw new Error('Account is disabled');
    if (member.status === 'suspended') throw new Error('Account is suspended');
    if (member.status === 'pruned') throw new Error('Account has been pruned');
    if (member.status === 'completed') throw new Error('Account closed');
    if (member.credit_frozen === 1) throw new Error('Frozen members cannot post in discussion threads');
}

export function postEnterpriseThreadMessage(
    cb: MessagingCallbacks,
    enterprisePubkey: string,
    authorPubkey: string,
    text: string,
    clientId?: string
): EnterpriseThreadMessage {
    const enterprise = db.prepare(
        "SELECT public_key, callsign, is_treasury, status, paused FROM members WHERE public_key = ?"
    ).get(enterprisePubkey) as any;
    if (!enterprise || !enterprise.is_treasury || isEnterpriseThreadHidden(enterprise.status)) {
        throw new Error('Enterprise not found');
    }
    if (enterprise.status === 'completed') {
        throw new Error('Enterprise has wound up — discussion thread is read-only');
    }
    // "Enterprise is closed", never the bare status word: the route maps an error naming "suspended" or
    // "disabled" to the AUTHOR's account being blocked (403), and this is the enterprise, not the author.
    if (isEnterpriseThreadReadOnly(enterprise.status)) {
        throw new Error('Enterprise is closed — discussion thread is read-only');
    }
    // Paused enterprise stays open: pausing is exactly when people need to talk about it.

    assertThreadMemberCanPost(authorPubkey);

    const cleanText = (text || '').trim();
    if (!cleanText) throw new Error('Message text cannot be empty');
    if (cleanText.length > 2000) throw new Error('Message is too long (maximum 2000 characters)');

    ensureEnterpriseThread(enterprisePubkey);

    if (clientId) {
        const existing = db.prepare("SELECT * FROM messages WHERE id = ?").get(clientId) as any;
        if (existing) {
            if (existing.author_pubkey === authorPubkey && existing.conversation_id === enterprisePubkey) {
                const senderMember = getMember(db, authorPubkey) as any;
                return {
                    id: existing.id,
                    conversationId: existing.conversation_id,
                    authorPubkey: existing.author_pubkey,
                    authorCallsign: senderMember?.callsign || authorPubkey.slice(0, 8),
                    authorAvatar: avatarUrlFor(authorPubkey, senderMember?.avatar_url),
                    ciphertext: existing.ciphertext,
                    nonce: existing.nonce,
                    type: existing.type,
                    metadata: existing.metadata,
                    timestamp: existing.timestamp,
                };
            }
            throw Object.assign(new Error('Message id already exists'), { code: 'ID_CONFLICT' });
        }
    }

    const msgId = clientId || crypto.randomUUID();
    const ciphertext = Buffer.from(cleanText, 'utf8').toString('base64');
    const nonce = 'plaintext-v1';
    const timestamp = new Date().toISOString();
    const type = 'text';

    db.prepare(`
        INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(msgId, enterprisePubkey, authorPubkey, ciphertext, nonce, type, timestamp);

    const senderMember = getMember(db, authorPubkey) as any;
    const msg: EnterpriseThreadMessage = {
        id: msgId,
        conversationId: enterprisePubkey,
        authorPubkey,
        authorCallsign: senderMember?.callsign || authorPubkey.slice(0, 8),
        authorAvatar: avatarUrlFor(authorPubkey, senderMember?.avatar_url),
        ciphertext,
        nonce,
        type,
        timestamp,
    };

    // Live update broadcast across WebSocket (no recipients filter so everyone viewing gets it)
    // Push notifications for DMs are NOT dispatched.
    cb.broadcast({
        type: 'new_message',
        conversationId: enterprisePubkey,
        message: msg,
        threadType: 'enterprise_thread',
    });

    return msg;
}

export function removeEnterpriseThreadMessage(
    cb: MessagingCallbacks,
    enterprisePubkey: string,
    messageId: string,
    actorPubkey: string
): EnterpriseThreadMessage {
    const enterprise = db.prepare(
        "SELECT public_key, callsign, is_treasury FROM members WHERE public_key = ?"
    ).get(enterprisePubkey) as any;
    if (!enterprise || !enterprise.is_treasury) {
        throw new Error('Enterprise not found');
    }

    if (!isKeeperOfEnterprise(actorPubkey, enterprisePubkey)) {
        throw new Error('Only a keeper of this enterprise can remove messages from its thread');
    }

    const msgRow = db.prepare("SELECT * FROM messages WHERE id = ? AND conversation_id = ?").get(messageId, enterprisePubkey) as any;
    if (!msgRow) {
        throw new Error('Message not found');
    }

    const removedText = 'removed by a keeper';
    const ciphertext = Buffer.from(removedText, 'utf8').toString('base64');
    const nonce = 'plaintext-v1';

    let metaObj: any = {};
    if (msgRow.metadata) {
        try { metaObj = JSON.parse(msgRow.metadata); } catch { }
    }
    metaObj.removed = true;
    metaObj.removedBy = actorPubkey;
    metaObj.removedAt = new Date().toISOString();
    const metadataStr = JSON.stringify(metaObj);

    db.prepare(`
        UPDATE messages
        SET type = 'removed', ciphertext = ?, nonce = ?, metadata = ?
        WHERE id = ?
    `).run(ciphertext, nonce, metadataStr, messageId);

    const authorMember = getMember(db, msgRow.author_pubkey) as any;
    const updatedMsg: EnterpriseThreadMessage = {
        id: messageId,
        conversationId: enterprisePubkey,
        authorPubkey: msgRow.author_pubkey,
        authorCallsign: authorMember?.callsign || msgRow.author_pubkey?.slice(0, 8),
        authorAvatar: avatarUrlFor(msgRow.author_pubkey, authorMember?.avatar_url),
        ciphertext,
        nonce,
        type: 'removed',
        metadata: metadataStr,
        timestamp: msgRow.timestamp,
    };

    cb.broadcast({
        type: 'new_message',
        conversationId: enterprisePubkey,
        message: updatedMsg,
        threadType: 'enterprise_thread',
        action: 'removed',
    });

    return updatedMsg;
}
