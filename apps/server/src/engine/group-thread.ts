// A Commons group's chat (groups redesign slice 1, decisions 3 and 12, 2026-09-19).
//
// Every group owns exactly one conversation: id = the group id, type 'group_thread'. Since group chats step 2 it is
// end-to-end encrypted (scratch/global-node/DESIGN-group-chat-encryption-fable.md, Marty's picks of 10 Oct 2026): every
// line is sealed on a member's phone under the group's current epoch key (engine/group-keys.ts), and the node stores
// only 'group-xc20p-v1:' lines it cannot open. It refuses a readable line, a line under any epoch but the current one,
// and any line while the current epoch is stale. A convenor still removes a line by its id, which needs no reading.
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
import { getMember, getConversation, isVisitorKey, assertConvenorPowersActive, type Conversation, type Message } from '@beanpool/engine';
import { detectMentions, groupPictureUrlOf, isGroupEncryptedPayload, GROUP_NONCE_PREFIX, type GroupRole, type GroupMemberStatus } from '@beanpool/core';
import { assertThreadMemberCanPost } from './enterprise-thread.js';
import { participantWriteAt, toThreadMessage, type EventThreadMessage } from './event-thread.js';
import { getChatMute, unmutedRecipients, type ChatMute } from './chat-mutes.js';
import { tombstoneFields, writeMessageTombstone } from './message-tombstone.js';
import type { MessagingCallbacks } from './messaging.js';
import {
    assertLineEpochIsCurrent, filterDeclaredMentions, fromEpochOf, groupChatEncryption, GroupKeyError, GROUP_CHAT_UPDATE_APP,
} from './group-keys.js';

// Moved to core (group-crypto.ts): the sending app detects mentions and declares them (§9). Still exported from here.
export { detectMentions };

export const GROUP_THREAD_TYPE = 'group_thread';
/** What a live chat update is about, beside a plain new message (chat parity, 2026-09-23). */
export type GroupChatAction = 'removed' | 'edited';
export const GROUP_THREAD_MESSAGE_MAX = 2000;
export const GROUP_THREAD_REMOVED_TEXT = 'removed by a convenor';
/** The one honest line the chat screen carries (decision 3; group chat encryption design §8). */
export const GROUP_THREAD_NOTICE =
    "End-to-end encrypted: only this group's members can read it. The node sees who wrote, when, and who was mentioned.";
/** What the day-zero wipe leaves where each readable line was, and the line it writes once per group (§14.1). */
export const GROUP_CHAT_WIPED_TEXT = 'Removed when this chat was locked';
export const GROUP_CHAT_LOCKED_TEXT = 'This chat is now end-to-end encrypted. Earlier messages, which this node could read, were removed.';
/**
 * The largest sealed line the node takes: GROUP_THREAD_MESSAGE_MAX characters of words (each UTF-16 unit at most three
 * UTF-8 bytes), the format byte, the signature, the 'after' length and id (at most 255 bytes), the AEAD tag.
 */
export const GROUP_LINE_MAX_BYTES = 3 * 2000 + 1 + 64 + 1 + 255 + 16;

export const GROUP_NOT_FOUND = 'Group not found';
export const GROUP_CHAT_FORBIDDEN = 'Only members of this group can open its chat';
export const GROUP_CHAT_OBSERVER = 'Observers can read this chat but not post in it';
export const GROUP_CHAT_NONCE_ERROR = GROUP_CHAT_UPDATE_APP;
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
    /** Once per group, when the node switched to locked lines and removed the readable ones (§14.1). */
    CHAT_LOCKED: 'GROUP_CHAT_LOCKED',
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
    /** The chat's lock (§14.3): its current epoch, whether a member must rotate before sending, and the viewer's first epoch. */
    encryption: { current: number | null; stale: boolean; fromEpoch: number | null };
}

interface GroupRow {
    id: string;
    name: string;
    slug: string;
    category: string;
    join_policy: string;
    /** The group's picture's reference (@beanpool/engine groups.ts setGroupPicture): its URL is made from it. */
    avatar_ref: string | null;
    created_by: string;
}

export function loadGroupForThread(groupId: string): GroupRow {
    const row = db.prepare('SELECT id, name, slug, category, join_policy, avatar_ref, created_by FROM groups WHERE id = ?')
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
 * The SQL test a line passes to be served to a reader whose first epoch is `?` (§3): a line sealed under an epoch from
 * before their membership is left out, a line with no epoch (a system line, a readable line's tombstone) is kept. A
 * reader with no epoch yet (null) is served no sealed line at all.
 */
const LINE_FOR_READER_SQL = `(json_extract(m.metadata, '$.epoch') IS NULL OR (? IS NOT NULL AND json_extract(m.metadata, '$.epoch') >= ?))`;

/** True if a stored line may be served to a reader whose first epoch is `fromEpoch` (LINE_FOR_READER_SQL, in code). */
export function groupLineForReader(metadata: unknown, fromEpoch: number | null): boolean {
    let epoch: unknown;
    try { epoch = (typeof metadata === 'string' ? JSON.parse(metadata) : metadata as any)?.epoch; } catch { epoch = undefined; }
    if (epoch === undefined || epoch === null) return true;
    return fromEpoch !== null && typeof epoch === 'number' && epoch >= fromEpoch;
}

export function getGroupThreadMessages(groupId: string, viewer: string, limit = 50, offset = 0): EventThreadMessage[] {
    const fromEpoch = fromEpochOf(groupId, viewer);
    const rows = db.prepare(`
        SELECT m.*, memb.callsign as author_callsign, memb.avatar_ref as author_avatar
        FROM messages m
        LEFT JOIN members memb ON m.author_pubkey = memb.public_key
        WHERE m.conversation_id = ? AND ${LINE_FOR_READER_SQL}
        ORDER BY m.timestamp DESC, m.rowid DESC
        LIMIT ? OFFSET ?
    `).all(groupId, fromEpoch, fromEpoch, limit, offset) as any[];
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
        messages: getGroupThreadMessages(groupId, viewerPubkey!, limit, offset),
        group: {
            id: group.id, name: group.name, slug: group.slug, category: group.category,
            joinPolicy: group.join_policy, avatarUrl: groupPictureUrlOf(group.id, group.avatar_ref),
        },
        role,
        canPost: role !== 'observer',
        isConvenor: role === 'convenor',
        notice: GROUP_THREAD_NOTICE,
        mute: getChatMute(groupId, viewerPubkey!),
        encryption: groupChatEncryption(groupId, viewerPubkey!),
    };
}

/** A sealed line as the apps send it (group chat encryption design Appendix A). */
export interface GroupLineIn {
    ciphertext: string;
    nonce: string;
    /** { epoch, replyToId?, mentions? }, as an object or its JSON. Nothing else in it is kept. */
    metadata?: unknown;
    /** The id the line was sealed under, if not passed beside it. */
    clientId?: string;
}

/** A sealed line is bound to its message id (core group-crypto.ts): the node stores it under that id or not at all. */
export const GROUP_LINE_NEEDS_ID = 'A sealed group line is sent with the id it was sealed under (a lower-case UUID v4).';
const SEALED_LINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function metadataObject(metadata: unknown): Record<string, unknown> {
    if (metadata === undefined || metadata === null || metadata === '') return {};
    let m: unknown = metadata;
    if (typeof metadata === 'string') {
        try { m = JSON.parse(metadata); } catch { throw new Error('A group line\'s metadata is JSON.'); }
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('A group line\'s metadata is JSON.');
    return m as Record<string, unknown>;
}

/**
 * The node's keyless check of a sealed line (Appendix B), for a send and an edit alike: the group prefix with a 24-byte
 * nonce and a ciphertext at least a sealed line long and no longer than GROUP_LINE_MAX_BYTES, under the current epoch,
 * not stale. A readable line, or any other form, is refused with the words an old app shows. Returns the epoch.
 */
export function assertSealedGroupLine(groupId: string, ciphertext: unknown, nonce: unknown, meta: Record<string, unknown>): number {
    if (!isGroupEncryptedPayload({ ciphertext, nonce })) throw new GroupKeyError(400, 'not_encrypted', GROUP_CHAT_UPDATE_APP);
    if (Buffer.byteLength(String(ciphertext), 'base64') > GROUP_LINE_MAX_BYTES) {
        throw new Error(`Message is too long (maximum ${GROUP_THREAD_MESSAGE_MAX} characters)`);
    }
    return assertLineEpochIsCurrent(groupId, meta.epoch);
}

/**
 * Post a sealed line in a group's chat. Convenors and members only; observers read. The same author block and client-id
 * idempotency as the other threads; the line must be sealed under the current, non-stale epoch (assertSealedGroupLine).
 * The node stores { epoch, replyToId?, mentions? } beside it, the mentions being the ones the app declared, cut to active
 * members other than the author (§9). Every other member in the chat gets a push unless they muted it; a mention gets
 * through a mute.
 */
export function postGroupThreadMessage(
    cb: MessagingCallbacks,
    groupId: string,
    authorPubkey: string,
    line: GroupLineIn,
    clientId?: string,
): EventThreadMessage {
    const group = loadGroupForThread(groupId);
    assertCanWriteInGroupChat(groupId, authorPubkey);

    const declared = metadataObject(line?.metadata);
    const epoch = assertSealedGroupLine(groupId, line?.ciphertext, line?.nonce, declared);
    clientId = clientId ?? line?.clientId;
    if (typeof clientId !== 'string' || !SEALED_LINE_ID.test(clientId)) throw new Error(GROUP_LINE_NEEDS_ID);
    const replyToId = typeof declared.replyToId === 'string' && declared.replyToId.trim() ? declared.replyToId : undefined;
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

    const mentions = filterDeclaredMentions(groupId, authorPubkey, declared.mentions);
    const msgId = clientId;
    const ciphertext = line.ciphertext;
    const nonce = line.nonce;
    const timestamp = new Date().toISOString();
    // `replyToId` is stored exactly as a DM stores it, so one component draws a quoted reply in either chat.
    const meta: Record<string, unknown> = { epoch };
    if (mentions.length > 0) meta.mentions = mentions;
    if (replyToId) meta.replyToId = replyToId;
    const metadata = JSON.stringify(meta);

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
    // After the answer, never inside it: the push skips anyone who has blocked the author (state-engine.ts
    // dispatchPushNotification), and their badge count's work in the answer would make a line's answer faster when
    // someone in the group has blocked its author, which would tell them (#1403 review).
    const senderName = sender?.callsign || 'A member';
    setImmediate(() => {
        try { pushGroupMessage(cb, group, authorPubkey, senderName, mentions); }
        catch (e: any) { console.warn('[Push] A group line push failed:', e?.message ?? e); }
    });
    return msg;
}

/**
 * Pushes for one message: a mention ignores a mute; everyone else in the chat is told unless they muted it. No message
 * text leaves the node in a push — it would travel through Apple's and Google's servers — and neither does the sender's
 * or the group's name: the lock screen shows the kind's fixed words, and "X mentioned you" in G stays here as the
 * notice's details (state-engine.ts dispatchPushNotification).
 */
function pushGroupMessage(cb: MessagingCallbacks, group: GroupRow, authorPubkey: string, senderName: string, mentions: string[]): void {
    const inChat = participantKeys(group.id).filter(pk => pk !== authorPubkey && canReadGroupThread(group.id, pk));
    const mentioned = inChat.filter(pk => mentions.includes(pk));
    const others = unmutedRecipients(group.id, inChat.filter(pk => !mentions.includes(pk)));
    const data = { screen: 'chat', conversationId: group.id, groupId: group.id };
    if (mentioned.length > 0) {
        cb.dispatchPushNotification(mentioned, authorPubkey, `👥 ${group.name}`, `${senderName} mentioned you`, data, 'chat', 'chat.mention');
    }
    if (others.length > 0) {
        cb.dispatchPushNotification(others, authorPubkey, `👥 ${group.name}`, `${senderName} sent a message`, data, 'chat', 'chat.group');
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
    // A convenor whose account is suspended removes nothing until it ends (the route answers 403 for "suspended").
    assertConvenorPowersActive(db, actorPubkey);
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
 * An edited group chat line (§7.4), checked exactly as a new one is: sealed, bounded, under the current non-stale epoch,
 * which the edit re-seals under. Returns what to store: the line as sent, and the row's metadata with its epoch moved
 * to the current one (the reply and the mentions stay the original's).
 */
export function groupChatEdit(groupId: string, row: { metadata?: string | null }, ciphertext: string, nonce: string, metadata: unknown): { ciphertext: string; nonce: string; metadata: string } {
    const epoch = assertSealedGroupLine(groupId, ciphertext, nonce, metadataObject(metadata));
    let kept: Record<string, unknown> = {};
    try { kept = row.metadata ? JSON.parse(row.metadata) : {}; } catch { kept = {}; }
    if (!kept || typeof kept !== 'object' || Array.isArray(kept)) kept = {};
    return { ciphertext, nonce, metadata: JSON.stringify({ ...kept, epoch }) };
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
 * A message that arrived through the ordinary POST /api/messages/send. Handed to postGroupThreadMessage, so the rules
 * are identical whichever route a message takes: a sealed line under the current epoch, text only (photos are a later
 * step). An app from before group chats were locked sends `plaintext-v1` here and is told to update.
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
    if (typeof nonce !== 'string' || !nonce.startsWith(GROUP_NONCE_PREFIX)) throw new GroupKeyError(400, 'not_encrypted', GROUP_CHAT_UPDATE_APP);
    if (type !== 'text' || hasAttachment) throw new Error('Only text can be sent to a group chat');
    // What this route's metadata carries into the chat: the epoch, a reply, and the mentions the app declared, which the
    // node cuts to active members (§9). Reactions stay the node's to write.
    return postGroupThreadMessage(cb, groupId, authorPubkey, { ciphertext, nonce, metadata }, clientId);
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

/**
 * Day zero for locked group chats (group chat encryption design §14.1, Marty's pick 2): every line of a group's chat
 * that this node could read becomes a tombstone ("Removed when this chat was locked"; its words, mentions, reactions and
 * reply go, and its updated_at moves, so a standby's next copy carries the tombstone, never the words), and each group
 * that had one gets one system line saying so. A sealed line, a system line and a line already down are left as they
 * are. Main server only, at boot; idempotent (a second run finds nothing readable left). Returns how many lines went.
 */
export function wipeReadableGroupLines(cb: MessagingCallbacks): number {
    const rows = db.prepare(`
        SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.type = 'group_thread' AND m.type NOT IN ('system', 'removed') AND m.nonce NOT LIKE '${GROUP_NONCE_PREFIX}%'
    `).all() as any[];
    if (rows.length === 0) return 0;
    const groups = new Set<string>();
    const write = db.prepare(`UPDATE messages SET type = 'removed', ciphertext = ?, nonce = 'plaintext-v1', metadata = ? WHERE id = ?`);
    db.transaction(() => {
        for (const row of rows) {
            const t = tombstoneFields(row, 'SYSTEM', GROUP_CHAT_WIPED_TEXT, { lockedAway: true });
            write.run(t.ciphertext, t.metadata, row.id);
            groups.add(row.conversation_id);
        }
    })();
    for (const g of groups) postGroupSystemLine(cb, g, GroupSystemType.CHAT_LOCKED, GROUP_CHAT_LOCKED_TEXT);
    return rows.length;
}
