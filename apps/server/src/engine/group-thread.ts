// A Commons group's chat (groups redesign slice 1, decisions 3 and 12, 2026-09-19).
//
// Every group owns exactly one conversation: id = the group id, type 'group_thread'. It is node-readable
// `plaintext-v1`, like the enterprise thread and the event chat, and says so on screen (GROUP_THREAD_NOTICE):
// a convenor has to be able to remove a message the server can read, and membership changes all the time.
// DMs stay end-to-end encrypted.
//
// Who is in it: the group's ACTIVE members — convenors, members and observers (groups-review.md §3.2).
// Observers read but do not post, exactly as they cannot post to the group today (engine/posts.ts). Pending
// requests and open invitations are not in it; leaving or being removed takes you out at once.
//
// As in the event chat (engine/event-thread.ts), group_members is the authority, re-checked on every read
// and every post. The conversation_participants rows are a mirror that feeds the Talk list, unread counts,
// live updates and pushes; leaving writes a tombstone so a backup drops the row too.
//
// Joins, leaves, removals, role changes and "an event / a poll was posted" land in the chat as system lines
// (decision 12): type 'system', author SYSTEM, nonce '00000' and the text stored as-is — the shape the escrow
// lines already use, which every app already in the stores draws as a small grey centred line.

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { getMember, getConversation, isVisitorKey, type Conversation, type Message } from '@beanpool/engine';
import type { GroupRole, GroupMemberStatus } from '@beanpool/core';
import { assertThreadMemberCanPost } from './enterprise-thread.js';
import { participantWriteAt, toThreadMessage, type EventThreadMessage } from './event-thread.js';
import { getChatMute, unmutedRecipients, type ChatMute } from './chat-mutes.js';
import { writeMessageTombstone } from './message-tombstone.js';
import type { MessagingCallbacks } from './messaging.js';

export const GROUP_THREAD_TYPE = 'group_thread';
/** What a live chat update is about, beside a plain new message (chat parity, 2026-09-23). */
export type GroupChatAction = 'removed' | 'edited';
export const GROUP_THREAD_MESSAGE_MAX = 2000;
export const GROUP_THREAD_REMOVED_TEXT = 'removed by a convenor';
/** The one honest line the chat screen carries (decision 3). */
export const GROUP_THREAD_NOTICE =
    "Visible to this group's members and this node's operator. For something private, message the person.";

export const GROUP_NOT_FOUND = 'Group not found';
export const GROUP_CHAT_FORBIDDEN = 'Only members of this group can open its chat';
export const GROUP_CHAT_OBSERVER = 'Observers can read this chat but not post in it';
export const GROUP_CHAT_NONCE_ERROR = 'Group chat messages are sent as plain text (plaintext-v1)';
/** An author's own delete, in a DM or a group chat. A convenor's removal keeps GROUP_THREAD_REMOVED_TEXT. */
export const GROUP_THREAD_DELETED_TEXT = 'This message was deleted';
export const GROUP_CHAT_REPLY_NOT_FOUND = 'The message being replied to is not in this chat';
export const GROUP_CHAT_REPLY_SYSTEM = 'A system line cannot be replied to';
export const GROUP_CHAT_SYSTEM_REACT_ERROR = 'A system line cannot be reacted to';

/** System-line kinds. The first four are membership housekeeping and never count as unread (QUIET_SYSTEM_TYPES in @beanpool/engine). */
export const GroupSystemType = {
    MEMBER_JOINED: 'GROUP_MEMBER_JOINED',
    MEMBER_LEFT: 'GROUP_MEMBER_LEFT',
    MEMBER_REMOVED: 'GROUP_MEMBER_REMOVED',
    ROLE_CHANGED: 'GROUP_ROLE_CHANGED',
    CONVENOR_VOTE_OPENED: 'GROUP_CONVENOR_VOTE_OPENED',
    CONVENOR_VOTE_CLOSED: 'GROUP_CONVENOR_VOTE_CLOSED',
    CONVENOR_CHOSEN: 'GROUP_CONVENOR_CHOSEN',
    /** The lead convenor handed the lead on (2026-09-23). Who leads the group is the group's business. */
    LEAD_HANDED_OVER: 'GROUP_LEAD_HANDED_OVER',
    EVENT_POSTED: 'GROUP_EVENT_POSTED',
    POLL_POSTED: 'GROUP_POLL_POSTED',
} as const;
export type GroupSystemTypeVal = typeof GroupSystemType[keyof typeof GroupSystemType];


export interface GroupThreadView {
    conversation: Conversation;
    messages: EventThreadMessage[];
    group: { id: string; name: string; slug: string; category: string; joinPolicy: string; avatarUrl: string | null };
    role: GroupRole;
    canPost: boolean;
    isConvenor: boolean;
    notice: string;
    mute: ChatMute | null;
}

interface GroupRow {
    id: string;
    name: string;
    slug: string;
    category: string;
    join_policy: string;
    avatar_url: string | null;
    created_by: string;
}

export function loadGroupForThread(groupId: string): GroupRow {
    const row = db.prepare('SELECT id, name, slug, category, join_policy, avatar_url, created_by FROM groups WHERE id = ?')
        .get(groupId) as GroupRow | undefined;
    if (!row) throw new Error(GROUP_NOT_FOUND);
    return row;
}

/**
 * The viewer's role while they are an ACTIVE member, else null. Never read from the participants mirror. A visitor's row
 * (isVisitorKey) has none, whatever group row it holds from before visitors were refused a group: it reads and writes a
 * group's chat as a key with no row does.
 */
export function groupChatRole(groupId: string, pubkey: string | undefined): GroupRole | null {
    if (!groupId || !pubkey || isVisitorKey(db, pubkey)) return null;
    const row = db.prepare("SELECT role FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active'")
        .get(groupId, pubkey) as { role: GroupRole } | undefined;
    return row?.role ?? null;
}

export function canReadGroupThread(groupId: string, pubkey: string | undefined): boolean {
    return groupChatRole(groupId, pubkey) !== null;
}

/**
 * Why this caller may not open the group's chat, as the status every route answers with — or null when they may.
 * An invite-only group answers 404, exactly as if it did not exist, unless the caller has a live relationship with
 * it (an invitation, a request): the #828 rule that invite-only groups stay hidden from outsiders. Anyone else
 * who is not an active member gets 403. Shared by the group routes and the ordinary messaging routes, so the two
 * never disagree about whether a group exists.
 */
export function groupChatRefusal(groupId: string, pubkey: string | undefined): { status: 403 | 404; error: string } | null {
    if (canReadGroupThread(groupId, pubkey)) return null;
    if (!visibleGroup(groupId, pubkey, { byIdOnly: true })) return { status: 404, error: GROUP_NOT_FOUND };
    return { status: 403, error: GROUP_CHAT_FORBIDDEN };
}

/** A group as the visibility rule sees it: its id, its policy, and the caller's live relationship to it (if any). */
export interface VisibleGroup {
    id: string;
    joinPolicy: string;
    /** The caller's group_members status — active, pending_approval or invited — or null for no live row (none, or removed). */
    relation: Exclude<GroupMemberStatus, 'removed'> | null;
}

/**
 * The #828 rule, for every route that takes a group id: the group, or null when this caller must be told it does
 * not exist. Null for an id nobody has, and null for an invite_only group the caller has no live row in — not a
 * member, not invited, not asking — so the two answers are indistinguishable (routes send 404 for both, never
 * 403). A removed row is a record, not a relationship. Signed-out callers have no relationship with anything.
 * A node admin gets no exception: nothing in node moderation reaches a group, so neither does sight of one.
 * `byIdOnly` for routes whose engine calls take the id and not the slug.
 */
export function visibleGroup(idOrSlug: string, pubkey: string | undefined, opts: { byIdOnly?: boolean } = {}): VisibleGroup | null {
    if (!idOrSlug) return null;
    const g = (opts.byIdOnly
        ? db.prepare('SELECT id, join_policy FROM groups WHERE id = ?').get(idOrSlug)
        : db.prepare('SELECT id, join_policy FROM groups WHERE id = ? OR slug = ? LIMIT 1').get(idOrSlug, idOrSlug)
    ) as { id: string; join_policy: string } | undefined;
    if (!g) return null;
    const row = pubkey
        ? db.prepare("SELECT status FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status != 'removed'")
            .get(g.id, pubkey) as { status: VisibleGroup['relation'] } | undefined
        : undefined;
    const relation = row?.status ?? null;
    if (g.join_policy === 'invite_only' && !relation) return null;
    return { id: g.id, joinPolicy: g.join_policy, relation };
}

function activeMemberKeys(groupId: string): string[] {
    return (db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(groupId) as any[])
        .map(r => r.member_pubkey);
}

function addParticipant(groupId: string, pubkey: string, nowIso: string): boolean {
    // `updated_at` is stamped strictly after any tombstone this member already has for the chat, so a replica
    // orders a re-join after the leaving. last_read_at starts now: joining does not make the history unread.
    return db.prepare(
        'INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key, last_read_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(groupId, pubkey, nowIso, participantWriteAt(groupId, pubkey)).changes > 0;
}

/**
 * The group's chat row, created with the group. A group made before this shipped gets its chat the first
 * time anything touches it, with every active member already in it.
 */
export function ensureGroupThread(groupId: string): Conversation {
    let conv = getConversation(db, groupId);
    if (conv) return conv;
    const group = loadGroupForThread(groupId);
    const nowIso = new Date().toISOString();
    db.transaction(() => {
        // created_at is now, not the group's: the delta backup exporter cursors conversations on created_at.
        db.prepare(`
            INSERT OR IGNORE INTO conversations (id, type, name, created_by, created_at)
            VALUES (?, 'group_thread', ?, ?, ?)
        `).run(groupId, group.name, group.created_by, nowIso);
        for (const pk of activeMemberKeys(groupId)) addParticipant(groupId, pk, nowIso);
    })();
    conv = getConversation(db, groupId);
    return conv!;
}

/** Give every existing group its chat (boot, primary only). Idempotent; returns how many it created. */
export function backfillGroupThreads(): number {
    const missing = db.prepare(`
        SELECT g.id FROM groups g
        WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = g.id)
    `).all() as { id: string }[];
    for (const g of missing) ensureGroupThread(g.id);
    return missing.length;
}

/**
 * Bring one person's chat membership in line with their group membership: an active member (any role) is
 * in the chat; anyone else is not, and leaving writes a tombstone so backups drop the row too.
 */
export function syncGroupThreadMembership(groupId: string, pubkey: string): 'added' | 'removed' | 'unchanged' {
    let exists = false;
    try { loadGroupForThread(groupId); exists = true; } catch { /* group gone: nothing to mirror */ }
    if (!exists) return 'unchanged';
    if (groupChatRole(groupId, pubkey)) {
        ensureGroupThread(groupId);
        return addParticipant(groupId, pubkey, new Date().toISOString()) ? 'added' : 'unchanged';
    }
    const writeAt = participantWriteAt(groupId, pubkey);
    let removed = false;
    db.transaction(() => {
        const r = db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').run(groupId, pubkey);
        if (r.changes === 0) return;
        removed = true;
        db.prepare(`
            INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at)
            VALUES ('conversation_participants', ?, ?)
        `).run(`${groupId}|${pubkey}`, writeAt);
    })();
    return removed ? 'removed' : 'unchanged';
}

function participantKeys(groupId: string): string[] {
    return (db.prepare('SELECT public_key FROM conversation_participants WHERE conversation_id = ?').all(groupId) as any[])
        .map(r => r.public_key);
}

/** Live update to the people in the chat only — never to every socket, as the enterprise thread does. */
function broadcastToChat(cb: MessagingCallbacks, groupId: string, message: EventThreadMessage, action?: GroupChatAction, extra: string[] = []): void {
    const recipients = Array.from(new Set([...participantKeys(groupId), ...extra]));
    cb.broadcast({
        type: 'new_message',
        conversationId: groupId,
        message,
        threadType: GROUP_THREAD_TYPE,
        ...(action ? { action } : {}),
    }, recipients);
}

export function callsignOf(pubkey: string | null | undefined): string {
    if (!pubkey) return 'Someone';
    return (getMember(db, pubkey) as any)?.callsign || pubkey.slice(0, 8);
}

/**
 * Write one system line into the group's chat (decision 12) and tell the people in it. Returns the stored
 * message, or null when the group no longer exists.
 */
export function postGroupSystemLine(
    cb: MessagingCallbacks,
    groupId: string,
    systemType: GroupSystemTypeVal,
    text: string,
    meta: Record<string, unknown> = {},
    alsoNotify: string[] = [],
): Message | null {
    try { ensureGroupThread(groupId); } catch { return null; }
    const msg: Message = {
        id: crypto.randomUUID(),
        conversationId: groupId,
        authorPubkey: 'SYSTEM',
        ciphertext: text,
        nonce: '00000',
        type: 'system',
        systemType,
        metadata: JSON.stringify({ groupId, ...meta }),
        timestamp: new Date().toISOString(),
    };
    db.prepare(`
        INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, system_type, metadata, timestamp)
        VALUES (?, ?, 'SYSTEM', ?, '00000', 'system', ?, ?, ?)
    `).run(msg.id, groupId, msg.ciphertext, systemType, msg.metadata, msg.timestamp);
    const shown = toThreadMessage({
        id: msg.id, author_pubkey: 'SYSTEM', author_callsign: 'System', ciphertext: msg.ciphertext, nonce: msg.nonce,
        type: 'system', metadata: msg.metadata, timestamp: msg.timestamp,
    }, groupId, GROUP_THREAD_REMOVED_TEXT);
    broadcastToChat(cb, groupId, { ...shown, systemType } as any, undefined, alsoNotify);
    return msg;
}

/**
 * The members @mentioned in a message: "@" + a member's callsign (any case), starting the text or after a
 * non-word character, and not running on into more letters or digits. Callsigns may contain spaces.
 */
export function detectMentions(text: string, candidates: { pubkey: string; callsign: string | null | undefined }[]): string[] {
    const lower = text.toLowerCase();
    const found = new Set<string>();
    for (const c of candidates) {
        const cs = (c.callsign || '').trim().toLowerCase();
        if (cs.length < 2) continue;
        const needle = `@${cs}`;
        let from = 0;
        while (from <= lower.length) {
            const at = lower.indexOf(needle, from);
            if (at < 0) break;
            const before = at === 0 ? '' : lower[at - 1];
            const after = lower[at + needle.length] ?? '';
            if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) {
                found.add(c.pubkey);
                break;
            }
            from = at + 1;
        }
    }
    return Array.from(found);
}

function memberCandidates(groupId: string, exclude: string): { pubkey: string; callsign: string | null }[] {
    return (db.prepare(`
        SELECT gm.member_pubkey AS pubkey, m.callsign AS callsign
        FROM group_members gm JOIN members m ON m.public_key = gm.member_pubkey
        WHERE gm.group_id = ? AND gm.status = 'active' AND gm.member_pubkey != ?
    `).all(groupId, exclude) as any[]);
}

export function getGroupThreadMessages(groupId: string, limit = 50, offset = 0): EventThreadMessage[] {
    const rows = db.prepare(`
        SELECT m.*, memb.callsign as author_callsign, memb.avatar_url as author_avatar
        FROM messages m
        LEFT JOIN members memb ON m.author_pubkey = memb.public_key
        WHERE m.conversation_id = ?
        ORDER BY m.timestamp DESC, m.rowid DESC
        LIMIT ? OFFSET ?
    `).all(groupId, limit, offset) as any[];
    return rows.reverse().map(r => ({ ...toThreadMessage(r, groupId, removedMarkerFor(r)), systemType: r.system_type || undefined }) as any);
}

/** The chat as one member sees it. Anyone who is not an active member of the group is refused. */
export function getGroupThread(groupId: string, viewerPubkey: string | undefined, limit = 50, offset = 0): GroupThreadView {
    const group = loadGroupForThread(groupId);
    const role = groupChatRole(groupId, viewerPubkey);
    if (!role) throw new Error(GROUP_CHAT_FORBIDDEN);
    const conversation = ensureGroupThread(groupId);
    return {
        conversation,
        messages: getGroupThreadMessages(groupId, limit, offset),
        group: {
            id: group.id, name: group.name, slug: group.slug, category: group.category,
            joinPolicy: group.join_policy, avatarUrl: group.avatar_url || null,
        },
        role,
        canPost: role !== 'observer',
        isConvenor: role === 'convenor',
        notice: GROUP_THREAD_NOTICE,
        mute: getChatMute(groupId, viewerPubkey!),
    };
}

/**
 * Post in a group's chat. Convenors and members only; observers read. The same author block, 2000-character
 * cap and client-id idempotency as the other node-readable threads. Every other member in the chat gets a
 * push (decision 12) unless they muted it — an @mention gets through a mute.
 */
export function postGroupThreadMessage(
    cb: MessagingCallbacks,
    groupId: string,
    authorPubkey: string,
    text: string,
    clientId?: string,
    replyToId?: string,
): EventThreadMessage {
    const group = loadGroupForThread(groupId);
    assertCanWriteInGroupChat(groupId, authorPubkey);

    const cleanText = (text || '').trim();
    if (!cleanText) throw new Error('Message text cannot be empty');
    if (cleanText.length > GROUP_THREAD_MESSAGE_MAX) {
        throw new Error(`Message is too long (maximum ${GROUP_THREAD_MESSAGE_MAX} characters)`);
    }
    // A reply quotes a message in THIS chat, never one from another chat and never a system line.
    if (replyToId) assertGroupChatReplyTarget(groupId, replyToId);

    ensureGroupThread(groupId);
    addParticipant(groupId, authorPubkey, new Date().toISOString());

    if (clientId) {
        const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(clientId) as any;
        if (existing) {
            if (existing.author_pubkey === authorPubkey && existing.conversation_id === groupId) {
                const sender = getMember(db, authorPubkey) as any;
                return toThreadMessage({ ...existing, author_callsign: sender?.callsign, author_avatar: sender?.avatar_url }, groupId, GROUP_THREAD_REMOVED_TEXT);
            }
            throw Object.assign(new Error('Message id already exists'), { code: 'ID_CONFLICT' });
        }
    }

    const mentions = detectMentions(cleanText, memberCandidates(groupId, authorPubkey));
    const msgId = clientId || crypto.randomUUID();
    const ciphertext = Buffer.from(cleanText, 'utf8').toString('base64');
    const nonce = 'plaintext-v1';
    const timestamp = new Date().toISOString();
    // `replyToId` is stored exactly as a DM stores it, so one component draws a quoted reply in either chat.
    const meta: Record<string, unknown> = {};
    if (mentions.length > 0) meta.mentions = mentions;
    if (replyToId) meta.replyToId = replyToId;
    const metadata = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;

    db.prepare(`
        INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp)
        VALUES (?, ?, ?, ?, ?, 'text', ?, ?)
    `).run(msgId, groupId, authorPubkey, ciphertext, nonce, metadata, timestamp);

    const sender = getMember(db, authorPubkey) as any;
    const msg = toThreadMessage({
        id: msgId, author_pubkey: authorPubkey, author_callsign: sender?.callsign, author_avatar: sender?.avatar_url,
        ciphertext, nonce, type: 'text', metadata: metadata ?? undefined, timestamp,
    }, groupId, GROUP_THREAD_REMOVED_TEXT);

    broadcastToChat(cb, groupId, msg);
    pushGroupMessage(cb, group, authorPubkey, sender?.callsign || 'A member', mentions);
    return msg;
}

/**
 * Pushes for one message: a mention reads "X mentioned you in G" and ignores a mute; everyone else in the
 * chat gets "X in G" unless they muted it. No message text leaves the node in a push — it would travel
 * through Apple's and Google's servers.
 */
function pushGroupMessage(cb: MessagingCallbacks, group: GroupRow, authorPubkey: string, senderName: string, mentions: string[]): void {
    const inChat = participantKeys(group.id).filter(pk => pk !== authorPubkey && canReadGroupThread(group.id, pk));
    const mentioned = inChat.filter(pk => mentions.includes(pk));
    const others = unmutedRecipients(group.id, inChat.filter(pk => !mentions.includes(pk)));
    const data = { screen: 'chat', conversationId: group.id, groupId: group.id };
    if (mentioned.length > 0) {
        cb.dispatchPushNotification(mentioned, authorPubkey, `👥 ${group.name}`, `${senderName} mentioned you`, data, 'chat');
    }
    if (others.length > 0) {
        cb.dispatchPushNotification(others, authorPubkey, `👥 ${group.name}`, `${senderName} sent a message`, data, 'chat');
    }
}

/** A convenor removes a message: it stays as "removed by a convenor", like the keeper and host removals. */
export function removeGroupThreadMessage(
    cb: MessagingCallbacks,
    groupId: string,
    messageId: string,
    actorPubkey: string,
): EventThreadMessage {
    loadGroupForThread(groupId);
    if (groupChatRole(groupId, actorPubkey) !== 'convenor') {
        throw new Error('Only a convenor can remove messages from this group chat');
    }
    const msgRow = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, groupId) as any;
    if (!msgRow) throw new Error('Message not found');
    if (msgRow.type === 'system') throw new Error('A system line cannot be removed');
    // Already down — a second removal is a no-op success, and must not rewrite who took it down first (an
    // author who deleted their own line stays the author on the record, not this convenor).
    if (msgRow.type === 'removed') return groupChatMessageOf(msgRow, groupId);

    writeMessageTombstone(messageId, msgRow, actorPubkey, GROUP_THREAD_REMOVED_TEXT);
    return broadcastGroupChatUpdate(cb, groupId, messageId, 'removed')!;
}

/**
 * THE GROUP CHAT'S WRITE RULE, in one place (chat parity, 2026-09-23). Edit, react and reply all mean writing
 * into the room, so they all ask the same question the send already asks: is this person an active convenor or
 * member of the GROUP (never the participants mirror), and is their account in a state that may post at all?
 * Observers read only; a removed member, someone who left, an outsider and a node admin who is not in the group
 * are all refused. Every route goes through this, including the generic messaging routes store apps up to
 * 1.2.37 call from their DM-style window, so no route can disagree with another about who may write here.
 */
export function assertCanWriteInGroupChat(groupId: string, actorPubkey: string): void {
    loadGroupForThread(groupId);
    const role = groupChatRole(groupId, actorPubkey);
    if (!role) throw new Error(GROUP_CHAT_FORBIDDEN);
    if (role === 'observer') throw new Error(GROUP_CHAT_OBSERVER);
    assertThreadMemberCanPost(actorPubkey);
}

/**
 * An edited group chat line, bounded exactly as a new one is: plaintext-v1 only, not empty, and the same
 * 2000-character cap — the reason the edit route refused a group chat in slice 1 was that it had neither.
 * Returns the base64 to store, re-encoded from the trimmed text.
 */
export function groupChatEditedCiphertext(ciphertext: string, nonce: string): string {
    if (nonce !== 'plaintext-v1') throw new Error(GROUP_CHAT_NONCE_ERROR);
    const text = Buffer.from(String(ciphertext), 'base64').toString('utf8').trim();
    if (!text) throw new Error('Message text cannot be empty');
    if (text.length > GROUP_THREAD_MESSAGE_MAX) {
        throw new Error(`Message is too long (maximum ${GROUP_THREAD_MESSAGE_MAX} characters)`);
    }
    return Buffer.from(text, 'utf8').toString('base64');
}

/** A message this group chat may be replied to: in this chat, and not a system line. */
export function assertGroupChatReplyTarget(groupId: string, replyToId: string): void {
    const target = db.prepare('SELECT type FROM messages WHERE id = ? AND conversation_id = ?')
        .get(replyToId, groupId) as { type: string } | undefined;
    if (!target) throw new Error(GROUP_CHAT_REPLY_NOT_FOUND);
    if (target.type === 'system') throw new Error(GROUP_CHAT_REPLY_SYSTEM);
}

/**
 * What a tombstone reads as: an author's own delete says so, a convenor's removal keeps the words it has always
 * had. The apps tell the two apart by `metadata.removedBy` (the contract), but the node's own text should not
 * blame a convenor for a delete the author made themselves.
 */
export function removedMarkerFor(row: { author_pubkey?: string | null; metadata?: string | null }): string {
    let meta: any = {};
    try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }
    return meta?.removedBy && meta.removedBy === row.author_pubkey ? GROUP_THREAD_DELETED_TEXT : GROUP_THREAD_REMOVED_TEXT;
}

/** One stored message row as the chat draws it (author's callsign and avatar, tombstone text). */
export function groupChatMessageOf(row: any, groupId: string): EventThreadMessage {
    const author = getMember(db, row.author_pubkey) as any;
    return toThreadMessage(
        { ...row, author_callsign: author?.callsign, author_avatar: author?.avatar_url },
        groupId,
        removedMarkerFor(row),
    );
}

/**
 * Tell the chat's members that one message changed — an edit, a delete, a convenor's removal — exactly the way
 * a removal has always been pushed (decision 3). `action` says which; there is no push for any of them.
 */
export function broadcastGroupChatUpdate(cb: MessagingCallbacks, groupId: string, messageId: string, action: GroupChatAction): EventThreadMessage | null {
    const row = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, groupId) as any;
    if (!row) return null;
    const msg = groupChatMessageOf(row, groupId);
    broadcastToChat(cb, groupId, msg, action);
    return msg;
}

/**
 * A message that arrived through the ordinary POST /api/messages/send (every app already in the stores sends
 * a non-DM chat that way, base64 `plaintext-v1`). Decoded and handed to postGroupThreadMessage, so the rules
 * are identical whichever route a message takes; nothing else is accepted.
 */
export function postGroupThreadMessageFromSendRoute(
    cb: MessagingCallbacks,
    groupId: string,
    authorPubkey: string,
    ciphertext: string,
    nonce: string,
    type: string,
    hasAttachment: boolean,
    clientId?: string,
    metadata?: string,
): EventThreadMessage {
    if (nonce !== 'plaintext-v1') throw new Error(GROUP_CHAT_NONCE_ERROR);
    if (type !== 'text' || hasAttachment) throw new Error('Only text can be sent to a group chat');
    const text = Buffer.from(String(ciphertext), 'base64').toString('utf8');
    // The only thing this route's metadata is allowed to carry into the chat: a reply, exactly as in a DM.
    // Everything else (mentions, reactions) is the node's to work out, so a client cannot fabricate it.
    return postGroupThreadMessage(cb, groupId, authorPubkey, text, clientId, replyToIdFrom(metadata));
}

/** The `replyToId` a client put in a send's metadata, or undefined. Never throws on malformed JSON. */
export function replyToIdFrom(metadata?: string | null): string | undefined {
    if (!metadata) return undefined;
    try {
        const parsed = JSON.parse(metadata);
        const id = parsed?.replyToId;
        return typeof id === 'string' && id.trim() ? id : undefined;
    } catch { return undefined; }
}
