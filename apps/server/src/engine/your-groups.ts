// "Your groups" (groups decisions 6, 7 and 13, 2026-09-19): one list of every group-like chat a member is in —
// their Commons groups, the enterprises they keep (🥖) and the events they host or are Going to (📅) — each
// with its latest message and the member's unread count, computed here per member.
//
// Built from the authorities, not from the participants mirror: an active group_members row, a keepership,
// an RSVP. So a group the member left or was removed from, a pending request, an open invitation, or an
// invite-only group they are not in never appears — the #828 rule holds without a separate filter.

import { db } from '../db/db.js';
import { COUNTS_AS_UNREAD_SQL, isEventHost } from '@beanpool/engine';
import { ensureGroupThread, syncGroupThreadMembership, GROUP_THREAD_REMOVED_TEXT } from './group-thread.js';
import {
    ensureEnterpriseThread, isKeeperOfEnterprise, isEnterpriseThreadHidden, isEnterpriseThreadReadOnly,
    ensureKeeperReadCursor, getKeeperReadCursor,
} from './enterprise-thread.js';
import {
    canReadEventThread, loadEventForThread, isEventThreadExpired, eventThreadReadOnlyReason, EVENT_THREAD_REMOVED_TEXT,
} from './event-thread.js';
import { getChatMutesFor, type ChatMute } from './chat-mutes.js';

export type YourChatKind = 'group' | 'enterprise' | 'event';

export const YOUR_CHAT_BADGES: Readonly<Record<YourChatKind, string | null>> = {
    group: null,
    enterprise: '🥖',
    event: '📅',
};

export interface YourChatLastMessage {
    id: string;
    authorPubkey: string;
    authorCallsign: string | null;
    type: string;
    systemType: string | null;
    /** Plain text for display: decoded plaintext-v1, a system line as written, or the removal notice. */
    text: string;
    timestamp: string;
}

export interface YourChat {
    kind: YourChatKind;
    /** 🥖 for an enterprise, 📅 for an event, null for a group. */
    badge: string | null;
    /** The owner: group id, enterprise pubkey, or event post id. */
    id: string;
    /** Open the chat with this id (it equals `id` for all three kinds). */
    conversationId: string;
    name: string;
    avatarUrl: string | null;
    /** Group: convenor | member | observer. Enterprise: lead | keeper. Event: host | going. */
    role: string;
    category?: string;
    joinPolicy?: string;
    eventStartAt?: string | null;
    eventEndAt?: string | null;
    readOnly: boolean;
    lastMessage: YourChatLastMessage | null;
    unreadCount: number;
    mute: ChatMute | null;
    /** Latest message time, else when the member's chat row was made — what the list is sorted by. */
    lastActivityAt: string;
}

const PREVIEW_MAX = 140;

function previewText(row: any, removedText: string): string {
    if (row.type === 'removed') return removedText;
    if (row.type === 'system') return String(row.ciphertext ?? '');
    let text = String(row.ciphertext ?? '');
    if (row.nonce === 'plaintext-v1') {
        try { text = Buffer.from(text, 'base64').toString('utf8'); } catch { /* keep as stored */ }
    }
    return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

function lastMessageOf(conversationId: string, removedText: string): YourChatLastMessage | null {
    const r = db.prepare(`
        SELECT m.id, m.author_pubkey, m.type, m.system_type, m.ciphertext, m.nonce, m.timestamp, memb.callsign
        FROM messages m LEFT JOIN members memb ON memb.public_key = m.author_pubkey
        WHERE m.conversation_id = ?
        ORDER BY m.timestamp DESC, m.rowid DESC LIMIT 1
    `).get(conversationId) as any;
    if (!r) return null;
    return {
        id: r.id,
        authorPubkey: r.author_pubkey,
        authorCallsign: r.author_pubkey === 'SYSTEM' ? null : (r.callsign || r.author_pubkey?.slice(0, 8) || null),
        type: r.type,
        systemType: r.system_type || null,
        text: previewText(r, removedText),
        timestamp: r.timestamp,
    };
}

function readCursor(kind: YourChatKind, conversationId: string, pubkey: string): { lastReadAt: string | null; since: string | null } | null {
    if (kind === 'enterprise') return getKeeperReadCursor(conversationId, pubkey);
    const r = db.prepare('SELECT last_read_at, updated_at FROM conversation_participants WHERE conversation_id = ? AND public_key = ?')
        .get(conversationId, pubkey) as any;
    return r ? { lastReadAt: r.last_read_at ?? null, since: r.updated_at ?? null } : null;
}

function unreadCountOf(conversationId: string, pubkey: string, lastReadAt: string | null): number {
    const r = db.prepare(`
        SELECT COUNT(*) AS c FROM messages m
        WHERE m.conversation_id = ? AND m.author_pubkey != ?
          AND (? IS NULL OR m.timestamp > ?)
          AND ${COUNTS_AS_UNREAD_SQL}
    `).get(conversationId, pubkey, lastReadAt, lastReadAt, pubkey) as any;
    return Number(r?.c || 0);
}

function avatarFor(pubkeyOrId: string, stored: string | null | undefined): string | null {
    if (!stored) return null;
    return stored.startsWith('bundled://') ? stored : `/api/avatar/${pubkeyOrId}?size=thumb`;
}

export function listYourChats(pubkey: string): { items: YourChat[]; totalUnread: number } {
    const mutes = getChatMutesFor(pubkey);
    const items: YourChat[] = [];

    // `since`: when a chat with no messages yet should sort — the member's joining or RSVP for a group or an
    // event, the enterprise's creation for its thread (the keeper's read cursor is made lazily and would float
    // every quiet enterprise to the top).
    const finish = (base: Omit<YourChat, 'lastMessage' | 'unreadCount' | 'mute' | 'lastActivityAt'>, removedText: string, since?: string | null) => {
        const cursor = readCursor(base.kind, base.conversationId, pubkey);
        const lastMessage = lastMessageOf(base.conversationId, removedText);
        items.push({
            ...base,
            lastMessage,
            unreadCount: unreadCountOf(base.conversationId, pubkey, cursor?.lastReadAt ?? null),
            mute: mutes.get(base.conversationId) ?? null,
            lastActivityAt: lastMessage?.timestamp || since || cursor?.since || new Date(0).toISOString(),
        });
    };

    // Commons groups: active membership only.
    const groups = db.prepare(`
        SELECT g.id, g.name, g.category, g.join_policy, g.avatar_url, gm.role
        FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE gm.member_pubkey = ? AND gm.status = 'active'
    `).all(pubkey) as any[];
    for (const g of groups) {
        ensureGroupThread(g.id);
        syncGroupThreadMembership(g.id, pubkey);
        finish({
            kind: 'group', badge: YOUR_CHAT_BADGES.group, id: g.id, conversationId: g.id, name: g.name,
            avatarUrl: g.avatar_url || null, role: g.role, category: g.category, joinPolicy: g.join_policy, readOnly: false,
        }, GROUP_THREAD_REMOVED_TEXT);
    }

    // Enterprises the member keeps (a keeper whose operator capability is live), not hidden ones.
    const enterprises = db.prepare(`
        SELECT o.treasury_pubkey AS id, o.role, e.callsign, e.avatar_url, e.status, e.joined_at
        FROM treasury_operators o JOIN members e ON e.public_key = o.treasury_pubkey
        WHERE o.member_pubkey = ? AND COALESCE(e.is_treasury, 0) = 1
    `).all(pubkey) as any[];
    for (const e of enterprises) {
        if (isEnterpriseThreadHidden(e.status) || !isKeeperOfEnterprise(pubkey, e.id)) continue;
        ensureEnterpriseThread(e.id);
        ensureKeeperReadCursor(e.id, pubkey);
        finish({
            kind: 'enterprise', badge: YOUR_CHAT_BADGES.enterprise, id: e.id, conversationId: e.id, name: e.callsign,
            avatarUrl: avatarFor(e.id, e.avatar_url), role: e.role === 'lead' ? 'lead' : 'keeper',
            readOnly: isEnterpriseThreadReadOnly(e.status),
        }, 'removed by a keeper', e.joined_at);
    }

    // Events the member hosts or is Going to, while their chat is still readable (30 days after the end).
    const events = db.prepare(`
        SELECT c.id FROM conversation_participants cp JOIN conversations c ON c.id = cp.conversation_id
        WHERE cp.public_key = ? AND c.type = 'event_thread'
    `).all(pubkey) as any[];
    for (const { id } of events) {
        let row: ReturnType<typeof loadEventForThread>;
        try { row = loadEventForThread(id); } catch { continue; }
        if (isEventThreadExpired(row) || !canReadEventThread(row, pubkey)) continue;
        const host = isEventHost(db, row, pubkey);
        const ev = db.prepare('SELECT event_start_at FROM posts WHERE id = ?').get(id) as any;
        finish({
            kind: 'event', badge: YOUR_CHAT_BADGES.event, id, conversationId: id, name: row.title, avatarUrl: null,
            role: host ? 'host' : 'going', eventStartAt: ev?.event_start_at ?? null, eventEndAt: row.event_end_at,
            readOnly: !!eventThreadReadOnlyReason(row),
        }, EVENT_THREAD_REMOVED_TEXT);
    }

    items.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
    return { items, totalUnread: items.reduce((n, i) => n + i.unreadCount, 0) };
}
