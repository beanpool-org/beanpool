// Event chat — the conversation every event carries (docs/events-on-the-map.md §2.1, §2.2, slice 4).
//
// Decisions 17, 20-23 and 25: an auto-created chat whose members are the host plus everyone marked Going;
// node-readable `plaintext-v1` like the enterprise thread, NOT the XChaCha20 DM scheme, because membership
// follows RSVPs and a host has to be able to remove a message the server can read. The private note is
// pinned at the top of the chat by the client and is never stored as a message, so editing the note never
// leaves a stale copy. Read-only once the event ends or is cancelled; scrubbed with the event after 30 days
// (that scrub is slice 6).
//
// Membership is mirrored into `conversation_participants` in step with `event_rsvps` so the chat appears in
// the Talk list with unread counts, and every read and post re-checks the RSVP anyway — the mirror is a
// convenience for the inbox, never the authority on who may read.

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import {
    getMember,
    getConversation,
    isEventHost,
    EVENT_READABLE_AFTER_END_MS,
    type Conversation,
    type EventRsvpStatus,
} from '@beanpool/engine';
import { assertThreadMemberCanPost } from './enterprise-thread.js';
import type { MessagingCallbacks } from './messaging.js';

export const EVENT_THREAD_MESSAGE_MAX = 2000;
export const EVENT_THREAD_REMOVED_TEXT = 'removed by the host';
/** The one line the chat screen carries: this chat is not end-to-end encrypted (decision 25). */
export const EVENT_THREAD_NOTICE = "Visible to the host, everyone going, and this node's operator.";

export const EVENT_NOT_FOUND = 'Event not found';
export const EVENT_CHAT_FORBIDDEN = 'Only the host and people going can open this event chat';
export const EVENT_CHAT_GONE = 'This event is no longer available';

export interface EventThreadMessage {
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

export interface EventThreadView {
    conversation: Conversation;
    messages: EventThreadMessage[];
    /** Ended or cancelled: the composer is gone and the screen says why. */
    readOnly: boolean;
    readOnlyReason: string | null;
    /** The viewer may post: they are the host or Going, and the event is still open. */
    canPost: boolean;
    isHost: boolean;
    title: string;
    eventEndAt: string | null;
    eventState: string;
    /** Pinned at the top of the chat for the host and everyone Going — never a message row. */
    privateNote: string | null;
    notice: string;
}

interface EventRow {
    id: string;
    title: string;
    active: number;
    status: string;
    event_state: string | null;
    event_end_at: string | null;
    author_pubkey: string;
    created_by: string | null;
    audience_scope: string | null;
    target_group_id: string | null;
    event_private_note: string | null;
}

const EVENT_COLUMNS = `id, title, active, status, event_state, event_end_at, author_pubkey, created_by,
                       audience_scope, target_group_id, event_private_note, type`;

/** The event row behind a chat, or a refusal. The chat id IS the post id (§2.1). */
export function loadEventForThread(postId: string): EventRow {
    const row = db.prepare(`SELECT ${EVENT_COLUMNS} FROM posts WHERE id = ?`).get(postId) as any;
    if (!row || row.type !== 'event') throw new Error(EVENT_NOT_FOUND);
    return row as EventRow;
}

/** Why the chat is read-only, or null while the event is still on. */
export function eventThreadReadOnlyReason(row: EventRow, nowMs = Date.now()): string | null {
    if (row.event_state === 'cancelled' || row.status === 'cancelled' || !row.active) {
        return 'This event was cancelled. The chat is read-only.';
    }
    if (row.event_end_at && Date.parse(row.event_end_at) <= nowMs) {
        return 'This event has ended. The chat is read-only.';
    }
    return null;
}

/**
 * Past the 30-day window the event itself stops being readable by id (getPosts), and so does its chat —
 * by then the scrub has taken the messages anyway.
 */
export function isEventThreadExpired(row: EventRow, nowMs = Date.now()): boolean {
    if (!row.event_end_at) return false;
    const endMs = Date.parse(row.event_end_at);
    if (!Number.isFinite(endMs) || endMs > nowMs) return false;
    return nowMs - endMs > EVENT_READABLE_AFTER_END_MS;
}

export function eventRsvpStatusOf(postId: string, pubkey: string | undefined): EventRsvpStatus | null {
    if (!pubkey) return null;
    try {
        const row = db.prepare(
            'SELECT status FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?'
        ).get(postId, pubkey) as { status: EventRsvpStatus } | undefined;
        return row?.status ?? null;
    } catch {
        return null; // table absent on an older schema
    }
}

/** Host or Going — checked on every read and every post, never trusted from the participants mirror. */
export function canReadEventThread(row: EventRow, pubkey: string | undefined): boolean {
    if (!pubkey) return false;
    if (isEventHost(db, row, pubkey)) return true;
    return eventRsvpStatusOf(row.id, pubkey) === 'going';
}

/**
 * The chat row, created with the post: id equal to the post id and `type = 'event_thread'`, mirroring
 * ensureEnterpriseThread. Lazily created for an event posted before this slice shipped.
 */
export function ensureEventThread(postId: string): Conversation {
    const row = loadEventForThread(postId);
    let conv = getConversation(db, postId);
    if (!conv) {
        const createdAt = new Date().toISOString();
        // An enterprise or group event is posted by a keeper or convenor: the acting member is the one who
        // belongs in the chat, not the enterprise's own pubkey (§2.2).
        const firstParticipant = row.created_by || row.author_pubkey;
        db.prepare(`
            INSERT OR IGNORE INTO conversations (id, type, name, created_by, created_at)
            VALUES (?, 'event_thread', ?, ?, ?)
        `).run(postId, row.title, firstParticipant, createdAt);
        addEventThreadParticipant(postId, firstParticipant);
        conv = getConversation(db, postId);
    }
    return conv!;
}

/** A participant row only for a real, non-enterprise member — an enterprise pubkey has no inbox. */
export function addEventThreadParticipant(postId: string, pubkey: string | null | undefined): void {
    if (!pubkey) return;
    const member = db.prepare(
        'SELECT public_key, COALESCE(is_treasury, 0) AS is_treasury FROM members WHERE public_key = ?'
    ).get(pubkey) as any;
    if (!member || member.is_treasury) return;
    db.prepare(
        'INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)'
    ).run(postId, pubkey);
}

/**
 * Mirror one RSVP into chat membership (§2.2): Going adds you, Interested or "not going" removes you. The
 * host never leaves the chat.
 *
 * The delta backup replicates `event_rsvps` with its tombstones but has no tombstone handler for
 * `conversation_participants`, so a replica can hold a membership row whose RSVP is gone. That is why the
 * read and post paths re-check the RSVP rather than the mirror.
 */
export function syncEventThreadMembership(postId: string, pubkey: string, status: EventRsvpStatus | null): void {
    let row: EventRow;
    try {
        row = loadEventForThread(postId);
    } catch {
        return;
    }
    if (status === 'going') {
        ensureEventThread(postId);
        addEventThreadParticipant(postId, pubkey);
        return;
    }
    if (isEventHost(db, row, pubkey)) return;
    db.prepare(
        'DELETE FROM conversation_participants WHERE conversation_id = ? AND public_key = ?'
    ).run(postId, pubkey);
}

function toThreadMessage(r: any, conversationId: string): EventThreadMessage {
    const displayCiphertext = r.type === 'removed'
        ? Buffer.from(EVENT_THREAD_REMOVED_TEXT, 'utf8').toString('base64')
        : r.ciphertext;
    return {
        id: r.id,
        conversationId,
        authorPubkey: r.author_pubkey,
        authorCallsign: r.author_callsign || r.author_pubkey?.slice(0, 8),
        authorAvatar: r.author_avatar
            ? (r.author_avatar.startsWith('bundled://')
                ? r.author_avatar
                : `/api/avatar/${r.author_pubkey}?size=thumb`)
            : null,
        ciphertext: displayCiphertext,
        nonce: r.nonce,
        type: r.type,
        metadata: r.metadata,
        timestamp: r.timestamp,
        editedAt: r.edited_at,
    };
}

export function getEventThreadMessages(postId: string, limit = 50, offset = 0): EventThreadMessage[] {
    const rows = db.prepare(`
        SELECT m.*, memb.callsign as author_callsign, memb.avatar_url as author_avatar
        FROM messages m
        LEFT JOIN members memb ON m.author_pubkey = memb.public_key
        WHERE m.conversation_id = ?
        ORDER BY m.timestamp DESC, m.rowid DESC
        LIMIT ? OFFSET ?
    `).all(postId, limit, offset) as any[];
    return rows.reverse().map(r => toThreadMessage(r, postId));
}

/**
 * The chat as one viewer sees it. Refuses a viewer who is neither the host nor Going, which is the whole
 * difference from the enterprise thread's read (that one is public by design).
 */
export function getEventThread(
    postId: string,
    viewerPubkey: string | undefined,
    limit = 50,
    offset = 0,
): EventThreadView {
    const row = loadEventForThread(postId);
    if (isEventThreadExpired(row)) throw new Error(EVENT_CHAT_GONE);
    if (!canReadEventThread(row, viewerPubkey)) throw new Error(EVENT_CHAT_FORBIDDEN);

    const conversation = ensureEventThread(postId);
    const readOnlyReason = eventThreadReadOnlyReason(row);
    const host = isEventHost(db, row, viewerPubkey);

    return {
        conversation,
        messages: getEventThreadMessages(postId, limit, offset),
        readOnly: !!readOnlyReason,
        readOnlyReason,
        canPost: !readOnlyReason,
        isHost: host,
        title: row.title,
        eventEndAt: row.event_end_at,
        eventState: row.event_state || 'scheduled',
        privateNote: row.event_private_note || null,
        notice: EVENT_THREAD_NOTICE,
    };
}

export function postEventThreadMessage(
    cb: MessagingCallbacks,
    postId: string,
    authorPubkey: string,
    text: string,
    clientId?: string,
): EventThreadMessage {
    const row = loadEventForThread(postId);
    if (isEventThreadExpired(row)) throw new Error(EVENT_CHAT_GONE);
    if (!canReadEventThread(row, authorPubkey)) throw new Error(EVENT_CHAT_FORBIDDEN);
    const readOnlyReason = eventThreadReadOnlyReason(row);
    if (readOnlyReason) throw new Error(readOnlyReason);

    assertThreadMemberCanPost(authorPubkey);

    const cleanText = (text || '').trim();
    if (!cleanText) throw new Error('Message text cannot be empty');
    if (cleanText.length > EVENT_THREAD_MESSAGE_MAX) {
        throw new Error(`Message is too long (maximum ${EVENT_THREAD_MESSAGE_MAX} characters)`);
    }

    ensureEventThread(postId);
    // A keeper or convenor host who never tapped Going still belongs in the chat once they speak in it.
    addEventThreadParticipant(postId, authorPubkey);

    if (clientId) {
        const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(clientId) as any;
        if (existing) {
            if (existing.author_pubkey === authorPubkey && existing.conversation_id === postId) {
                const senderMember = getMember(db, authorPubkey) as any;
                return toThreadMessage({
                    ...existing,
                    author_callsign: senderMember?.callsign,
                    author_avatar: senderMember?.avatar_url,
                }, postId);
            }
            throw Object.assign(new Error('Message id already exists'), { code: 'ID_CONFLICT' });
        }
    }

    const msgId = clientId || crypto.randomUUID();
    const ciphertext = Buffer.from(cleanText, 'utf8').toString('base64');
    const nonce = 'plaintext-v1';
    const timestamp = new Date().toISOString();

    db.prepare(`
        INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp)
        VALUES (?, ?, ?, ?, ?, 'text', ?)
    `).run(msgId, postId, authorPubkey, ciphertext, nonce, timestamp);

    const senderMember = getMember(db, authorPubkey) as any;
    const msg = toThreadMessage({
        id: msgId,
        author_pubkey: authorPubkey,
        author_callsign: senderMember?.callsign,
        author_avatar: senderMember?.avatar_url,
        ciphertext,
        nonce,
        type: 'text',
        timestamp,
    }, postId);

    broadcastEventThreadMessage(cb, postId, msg);
    // No push per message, as for the enterprise thread (messaging.ts skips threads).
    return msg;
}

export function removeEventThreadMessage(
    cb: MessagingCallbacks,
    postId: string,
    messageId: string,
    actorPubkey: string,
): EventThreadMessage {
    const row = loadEventForThread(postId);
    if (!isEventHost(db, row, actorPubkey)) {
        throw new Error('Only the host can remove messages from this event chat');
    }

    const msgRow = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?')
        .get(messageId, postId) as any;
    if (!msgRow) throw new Error('Message not found');

    const ciphertext = Buffer.from(EVENT_THREAD_REMOVED_TEXT, 'utf8').toString('base64');
    let metaObj: any = {};
    if (msgRow.metadata) {
        try { metaObj = JSON.parse(msgRow.metadata); } catch { /* keep the replacement metadata */ }
    }
    metaObj.removed = true;
    metaObj.removedBy = actorPubkey;
    metaObj.removedAt = new Date().toISOString();
    const metadataStr = JSON.stringify(metaObj);

    db.prepare(`
        UPDATE messages SET type = 'removed', ciphertext = ?, nonce = 'plaintext-v1', metadata = ?
        WHERE id = ?
    `).run(ciphertext, metadataStr, messageId);

    const authorMember = getMember(db, msgRow.author_pubkey) as any;
    const updated = toThreadMessage({
        ...msgRow,
        ciphertext,
        nonce: 'plaintext-v1',
        type: 'removed',
        metadata: metadataStr,
        author_callsign: authorMember?.callsign,
        author_avatar: authorMember?.avatar_url,
    }, postId);

    broadcastEventThreadMessage(cb, postId, updated, 'removed');
    return updated;
}

/**
 * Live update to the people in the chat only. Unlike the enterprise thread — which is public and broadcasts
 * to every socket — an event chat is the host plus Going, and a group-only event's chat is narrower still.
 */
function broadcastEventThreadMessage(
    cb: MessagingCallbacks,
    postId: string,
    message: EventThreadMessage,
    action?: 'removed',
): void {
    const parts = db.prepare(
        'SELECT public_key FROM conversation_participants WHERE conversation_id = ?'
    ).all(postId) as any[];
    const recipients = Array.from(new Set(parts.map(p => p.public_key)));
    cb.broadcast({
        type: 'new_message',
        conversationId: postId,
        message,
        threadType: 'event_thread',
        ...(action ? { action } : {}),
    }, recipients);
}
