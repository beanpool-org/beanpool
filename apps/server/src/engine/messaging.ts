// Stateful messaging mutations, conversation management & system event injection.
//
// Extracted from apps/server/src/state-engine.ts.

import { isSyntheticAccount, type PushNoticeKind } from '@beanpool/core';
import { db, afterTransactionCommit, deletePlainRows } from '../db/db.js';
import crypto from 'node:crypto';
import { attachmentKey, getImageStore } from '../storage/image-store.js';
import { deleteStoredObjects, storeAttachmentColumns } from '../storage/image-columns.js';
import {
    getMember,
    getConversation,
    isInvalidatedKey,
    isNodeMember,
    isLiveVisitor,
    SystemMessageType,
    type Conversation,
    type Message,
    type SystemMessageTypeVal,
    type TypedMessagePayload
} from '@beanpool/engine';
import {
    GROUP_THREAD_TYPE, GROUP_CHAT_FORBIDDEN, GROUP_CHAT_OBSERVER, GROUP_CHAT_SYSTEM_REACT_ERROR,
    GROUP_NOT_FOUND, GROUP_THREAD_DELETED_TEXT, postGroupThreadMessageFromSendRoute,
    assertCanWriteInGroupChat, groupChatEditedCiphertext, groupChatRefusal, broadcastGroupChatUpdate,
} from './group-thread.js';
import { writeMessageTombstone, tombstoneFields } from './message-tombstone.js';
import { eventChatUnknownTo } from './event-thread.js';
import { unmutedRecipients } from './chat-mutes.js';
import { NOT_A_MEMBER_ERROR, NOT_A_MEMBER_CODE } from './members.js';
import { hasBlocked } from './member-blocks.js';
import {
    withheldConversationOwnedBy, withheldConversationOfPair, openWithheldConversation, dropWithheldConversation,
    withheldLine, ownWithheldLine, storeWithheldLine, editWithheldLine, setWithheldLineMetadata, tombstoneWithheldLine,
    withheldLineMessage, type WithheldConversation,
    overlayOf, setOverlayReaction, setOverlayEdit, clearOverlayEdit, dropOverlaysOn, withOwnReaction, withOwnOverlay,
} from './withheld-lines.js';

type BroadcastFn = (event: any, recipients?: string[]) => void;
type PushFn = (targetPubkeys: string[], actorPubkey: string, title: string, body: string, data: Record<string, any>, categoryId: 'chat' | 'marketplace' | 'escrow', kind: PushNoticeKind) => void;
type RegisterVisitorFn = (pubkey: string) => void;

export interface MessagingCallbacks {
    broadcast: BroadcastFn;
    dispatchPushNotification: PushFn;
    /**
     * The same work as dispatchPushNotification, stopping before the notices are kept and anything goes to the push service.
     * For a line withheld from its recipient (engine/withheld-lines.ts), so it costs what a stored one does (#1403 re-review).
     */
    rehearsePushNotification?: PushFn;
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
    // The old key of a member being re-keyed (a lost or stolen phone): its row is 'suspended', which the lines above
    // let write, so it would go on messaging people as them.
    if (isInvalidatedKey(db, publicKey)) throw new MessagingError(NOT_A_MEMBER_ERROR, 403);
}

/** A visitor's line anywhere but a direct conversation it is in: refused in the words a key with no row is refused in. */
const VISITOR_SEND_REFUSAL = 'Member not found';

/**
 * Whether `publicKey` is a visitor's row (isLiveVisitor) and `messageId` a line of a direct conversation it is in. There
 * a visitor edits and deletes its own lines and reacts, as anyone in a DM does (the director, 2026-09-26: messaging is
 * what Marty's answer gives a visitor, and one that can't take its own words back is worse off). Anywhere else a
 * visitor's row changes no line, and is answered as a key with no row is.
 */
export function isVisitorsDirectLine(messageId: unknown, publicKey: string | undefined): boolean {
    if (typeof messageId !== 'string' || !messageId || !publicKey || !isLiveVisitor(db, publicKey)) return false;
    // A line of its own kept for it alone (engine/withheld-lines.ts) is one too.
    if (ownWithheldLine(messageId, publicKey)) return true;
    return !!db.prepare(`
        SELECT 1 FROM messages m
        JOIN conversations c ON c.id = m.conversation_id AND c.type = 'dm'
        JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.public_key = ?
        WHERE m.id = ?
    `).get(publicKey, messageId);
}

/**
 * Whether `conversationId` is a direct conversation `publicKey`, a visitor's row (isLiveVisitor), is in: where it marks read
 * and mutes (visitor-allowlist.ts VISITOR_WRITES).
 */
export function isVisitorsDirectConversation(conversationId: unknown, publicKey: string | undefined): boolean {
    if (typeof conversationId !== 'string' || !conversationId || !publicKey || !isLiveVisitor(db, publicKey)) return false;
    // One kept for it alone, because the other had blocked it (engine/withheld-lines.ts), is one it is in.
    if (withheldConversationOwnedBy(conversationId, publicKey)) return true;
    return !!db.prepare(`
        SELECT 1 FROM conversations c
        JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.public_key = ?
        WHERE c.id = ? AND c.type = 'dm'
    `).get(publicKey, conversationId);
}

/**
 * The conversation an old conversation id was folded into (chat consolidation): a line stored there names the old id in
 * its metadata, `originalConversationId` or an item of `originalConversationIds`. Undefined when no line does. The
 * earliest such line decides, as when this scanned the table in order.
 *
 * Looked up in message_old_conversation_ids (schema.sql), which the messages triggers keep from each line's metadata:
 * one index probe, whether or not a line names the id. Scanning every line's metadata instead made an id nobody has
 * cost ~35 ms at 100k lines, where a hidden group's chat id is answered at once, so the time told the two apart
 * (#1333 review). A list's items match exactly now; the scan matched any part of the list's text.
 */
function consolidatedConversationOf(conversationId: string): string | undefined {
    const row = db.prepare(`
        SELECT m.conversation_id FROM message_old_conversation_ids o
        JOIN messages m ON m.id = o.message_id
        WHERE o.old_conversation_id = ?
        ORDER BY m.rowid
        LIMIT 1
    `).get(conversationId) as { conversation_id?: string } | undefined;
    return row?.conversation_id || undefined;
}

/**
 * Whether a visitor's row may send to `conversationId`: a direct conversation it is in, or an old id of one, which
 * sendMessage follows to the one it became (chat consolidation). Anything else, an id nobody has included, is refused at
 * the gate in the same words: letting every id that names no conversation through told a visitor, by the engine's
 * different answer, which ids do name one (a hidden group's chat is its group's id).
 */
export function visitorMaySendTo(conversationId: unknown, publicKey: string | undefined): boolean {
    if (isVisitorsDirectConversation(conversationId, publicKey)) return true;
    if (typeof conversationId !== 'string' || !conversationId || !publicKey || !isLiveVisitor(db, publicKey)) return false;
    if (db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) return false;
    let folded: string | undefined;
    try { folded = consolidatedConversationOf(conversationId); } catch { return false; }
    return !!folded && isVisitorsDirectConversation(folded, publicKey);
}

/**
 * Whether a visitor's row asks for a direct conversation it is already in (an app asks before it writes): two distinct
 * participants, itself one of them, who have one. assertMayOpenConversation refuses it any other.
 */
export function isVisitorsDirectConversationWith(publicKey: string | undefined, participants: unknown): boolean {
    if (!publicKey || !Array.isArray(participants) || !isLiveVisitor(db, publicKey)) return false;
    const unique = [...new Set(participants)];
    if (unique.length !== 2 || !unique.every(p => typeof p === 'string') || !unique.includes(publicKey)) return false;
    return !!findDirectConversationRow(unique[0] as string, unique[1] as string);
}

/** An edit or a deletion by a visitor's row, of a line outside its direct conversations: the words a key with no row gets. */
function refuseVisitorOutsideItsDirectConversations(messageId: string, publicKey: string): void {
    if (isLiveVisitor(db, publicKey) && !isVisitorsDirectLine(messageId, publicKey)) throw new MessagingError(VISITOR_SEND_REFUSAL);
}

/**
 * The old chat group ("👥 Group" in the web app's Talk screen) was removed on 2026-09-19 (groups decision 2):
 * a group chat is now the chat every Commons group owns (engine/group-thread.ts). The create route answers
 * any other type with this, as a 410.
 */
export const CHAT_GROUP_REMOVED_ERROR =
    'Group chats made from Talk were removed. Create a group in Commons instead — every group has its own chat.';

/**
 * A member's words in a direct conversation are stored only end-to-end encrypted: the privacy policy tells members
 * the server keeps them "in a form only the two of you can read", and that has to be true of every line, not of
 * most. Both apps used to fall back to readable `plaintext-v1` whenever they could not find the other person's key;
 * they now refuse to send instead, and this is the node refusing what an older app still sends (PR #1283 review).
 * What the node writes itself into a DM is not a member's message and stays as it was: the deal notices
 * (injectSystemMessage), a removed message's tombstone, and a message from the node's admin page, which the
 * operator typed on the node.
 */
export const DM_NOT_ENCRYPTED_ERROR =
    "This message wasn't locked for the other person, so it wasn't sent. Only the two of you can read a direct message. Try again in a moment, or update the app.";
export const DM_NOT_ENCRYPTED_CODE = 'dm_not_encrypted';
/** A direct conversation is named by its two people; a name typed for one would be words the node can read. */
export const DM_NAME_REFUSED_ERROR =
    'A direct conversation has no name. Send the words as a message: it is locked so only the two of you can read it.';

/** The nonce prefix of an end-to-end encrypted DM (apps/pwa/src/lib/e2e-crypto.ts, apps/native/utils/e2e-crypto.ts). */
export const DM_ENCRYPTED_NONCE_PREFIX = 'x25519-xc20p-v2:';
const DM_NONCE_BYTES = 24;       // XChaCha20
const AEAD_TAG_BYTES = 16;       // Poly1305: what encrypting an empty caption produces

/** `s` is standard, padded base64 exactly as both apps write it, of at least `minBytes` bytes. */
function isCanonicalBase64(s: unknown, minBytes: number): boolean {
    if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return false;
    const bytes = Buffer.from(s, 'base64');
    return bytes.length >= minBytes && bytes.toString('base64') === s;
}

/**
 * Whether a DM payload is in the encrypted form (v2): the versioned nonce carrying a 24-byte nonce, and a ciphertext
 * at least as long as the AEAD tag. The node cannot check the words are really encrypted — it has no key, which is the
 * point — but it can refuse every form that is not, `plaintext-v1` first among them.
 */
export function isEncryptedDmPayload(ciphertext: unknown, nonce: unknown): boolean {
    if (typeof nonce !== 'string' || !nonce.startsWith(DM_ENCRYPTED_NONCE_PREFIX)) return false;
    const nonceBody = nonce.slice(DM_ENCRYPTED_NONCE_PREFIX.length);
    if (!isCanonicalBase64(nonceBody, DM_NONCE_BYTES) || Buffer.from(nonceBody, 'base64').length !== DM_NONCE_BYTES) return false;
    return isCanonicalBase64(ciphertext, AEAD_TAG_BYTES);
}

function refuseUnencryptedDm(ciphertext: unknown, nonce: unknown): void {
    if (!isEncryptedDmPayload(ciphertext, nonce)) throw new MessagingError(DM_NOT_ENCRYPTED_ERROR, 400, DM_NOT_ENCRYPTED_CODE);
}

/**
 * The id a line relayed from another node is stored under: the sender's own, verbatim, when it is a UUID v4 (lowered, as
 * the send route lowers it). A DM line is sealed to its message id (apps' e2e-crypto, format 3), so a line stored under a
 * new id would be one its recipient can't verify. Anything else gets an id of this node's, as before.
 */
export function relayedMessageId(id: unknown): string | undefined {
    return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : undefined;
}

/** One DM per pair, never keyed to a post (chat consolidation): the pair's conversation row, if they have one. */
function findDirectConversationRow(a: string, b: string): any {
    return db.prepare(`
        SELECT c.* FROM conversations c
        JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.public_key = ?
        JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.public_key = ?
        WHERE c.type = 'dm' AND c.post_id IS NULL
    `).get(a, b);
}

/**
 * Who may open a conversation over the route: a visitor's row (isLiveVisitor) opens none. It may ask again for a
 * direct conversation it is already in (an app asks before it writes), and is refused a new one in the words a key with
 * no row is refused in, so it makes no row for anyone. Federation's relay opens one for a member of another community
 * by calling createConversation itself.
 */
export function assertMayOpenConversation(createdBy: string, participants: string[]): void {
    if (!isLiveVisitor(db, createdBy)) return;
    if (!findDirectConversationRow(participants[0], participants[1])) throw new MessagingError(VISITOR_SEND_REFUSAL);
}

export function createConversation(
    cb: MessagingCallbacks,
    type: 'dm',
    participants: string[],
    createdBy: string,
    name?: string,
    /**
     * A caller's own limit on what this writes (the DM route's new-people-a-day, W-main): run once every refusal above has
     * passed and before anything is written, a visitor's row for someone new included, so a limit never answers for a
     * caller who may not open the conversation at all.
     */
    beforeWrite?: () => void,
    /**
     * `asNode`: the node opens it, not a member (a deal's chat, the admin page's message, the chat consolidation), so a
     * block never withholds it: a trade under way keeps its chat and the node's notices in it.
     */
    opts: { asNode?: boolean } = {}
): Conversation | null {
    if (type !== 'dm') throw new MessagingError(CHAT_GROUP_REMOVED_ERROR, 410);
    if (participants.length !== 2) throw new MessagingError('DM conversations must have exactly 2 distinct participants');
    assertMemberActive(createdBy);
    beforeWrite?.();
    if (cb.registerVisitor) {
        for (const p of participants) {
            if (!getMember(db, p)) cb.registerVisitor(p);
        }
    }

    const existing = findDirectConversationRow(participants[0], participants[1]);
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

    const createdAt = new Date().toISOString();
    // Someone who has blocked the opener gets no new chat in their list: the conversation is kept for the opener alone
    // (engine/withheld-lines.ts), answered and announced to them exactly as a new one is, and asked for again it is the
    // same one. Every refusal and limit above has run first, so the answer is the one anybody else would get.
    const other = participants.find(p => p !== createdBy);
    if (!opts.asNode && other && hasBlocked(other, createdBy)) {
        const { conversation: kept, created } = openWithheldConversation(createdBy, other, crypto.randomUUID(), createdAt);
        // A conversation already opened lists its two as a real one does, by key; a new one as the opener named them.
        const conv: Conversation = { id: kept.id, type, name: name || null, createdBy: kept.owner_pubkey, createdAt: kept.created_at, participants: created ? participants : [...participants].sort() };
        if (created) cb.broadcast({ type: 'conversation_created', conversation: conv }, [createdBy]);
        return conv;
    }

    // A conversation kept for one of them while blocked becomes this one, under its id: the one the opener's app already
    // encrypts against. Its withheld lines stay withheld.
    const kept = withheldConversationOfPair(participants[0], participants[1]);
    const id = kept?.id ?? crypto.randomUUID();
    db.transaction(() => {
        if (kept) dropWithheldConversation(kept.id);
        db.prepare(`INSERT INTO conversations (id, type, post_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, type, null, name || null, createdBy, createdAt);
        const insertPart = db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)`);
        for (const p of participants) insertPart.run(id, p);
        if (kept) keepOwnersReadMarker(kept);
    })();

    const conv: Conversation = { id, type, name: name || null, createdBy, createdAt, participants };
    // A DM's existence says who is talking to whom: only its two participants hear of it.
    // Its owner was told of it when they opened it: only the other, for whom it is new, hears of it now.
    cb.broadcast({ type: 'conversation_created', conversation: conv }, kept ? participants.filter(p => p !== kept.owner_pubkey) : participants);
    return conv;
}

/**
 * A withheld conversation (engine/withheld-lines.ts) its owner writes in once the block is lifted: it becomes the real
 * conversation between the two, under its id, and the other hears of it as of any new conversation (its owner had it
 * already). When the two have a real
 * one already (only a conversation opened some other way than createConversation could be), the withheld one goes and
 * the line goes there. Returns the id the line is stored under.
 */
function promoteWithheldConversation(cb: MessagingCallbacks, kept: WithheldConversation, author: string): string {
    const participants = [kept.owner_pubkey, kept.other_pubkey];
    const real = findDirectConversationRow(participants[0], participants[1]);
    if (real) {
        dropWithheldConversation(kept.id);
        return real.id;
    }
    const createdAt = new Date().toISOString();
    db.transaction(() => {
        dropWithheldConversation(kept.id);
        db.prepare(`INSERT INTO conversations (id, type, post_id, name, created_by, created_at) VALUES (?, 'dm', NULL, NULL, ?, ?)`).run(kept.id, author, createdAt);
        const insertPart = db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)`);
        for (const p of participants) insertPart.run(kept.id, p);
        keepOwnersReadMarker(kept);
    })();
    const conv: Conversation = { id: kept.id, type: 'dm', name: null, createdBy: author, createdAt, participants };
    // Its owner was told of it when they opened it: only the other, for whom it is new, hears of it now.
    cb.broadcast({ type: 'conversation_created', conversation: conv }, participants.filter(p => p !== kept.owner_pubkey));
    return kept.id;
}

/** A withheld conversation now the real one: its owner's read marker goes on to their participant row. */
function keepOwnersReadMarker(kept: WithheldConversation): void {
    if (!kept.owner_last_read_at) return;
    db.prepare('UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND public_key = ?')
        .run(kept.owner_last_read_at, kept.id, kept.owner_pubkey);
}

/** A line already stored under this client id, in `messages` or withheld (engine/withheld-lines.ts). */
function storedLineWithId(id: string): any {
    return db.prepare("SELECT * FROM messages WHERE id=?").get(id) ?? withheldLine(id);
}

/** `metadata` (a JSON string a client sent) without the keys only the node's own tombstone carries. */
export function withoutTombstoneKeys(metadata: string | undefined): string | undefined {
    if (typeof metadata !== 'string' || !metadata) return metadata;
    let obj: any;
    try { obj = JSON.parse(metadata); } catch { return metadata; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return metadata;
    let hit = false;
    for (const k of ['removed', 'removedBy', 'removedAt', 'accountDeleted']) {
        if (k in obj) { delete obj[k]; hit = true; }
    }
    return hit ? JSON.stringify(obj) : metadata;
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
    clientId?: string,
    opts: {
        /** The node's own words into a DM (the admin page's message), not a member's: stored as written. */
        nodeAuthored?: boolean;
        /**
         * A caller's own limit on the line as it would be stored (the send route's 64 KB, W-main): run once every refusal
         * below has passed (who may write here, the idempotent retry, encrypted or not at all) and just before the line is
         * written, so a limit never answers for a caller who may not write in this conversation. Not run for a group
         * chat line, which its own rule book bounds (2000 characters, and only a reply id kept from its metadata).
         */
        beforeStore?: (stored: { ciphertext: string; metadata?: string }) => void;
    } = {}
): Message | null {
    assertMemberActive(authorPubkey);
    // A visitor's row (isLiveVisitor) writes only in a direct conversation it is already in (checked again below, once
    // an old conversation id has been followed to the one it became). A member of another community relayed by a peer
    // is one, writing to a member here.
    const visitor = isLiveVisitor(db, authorPubkey);
    // A group's chat has one rule book (engine/group-thread.ts): membership re-checked against the group, not
    // the participants mirror; observers read only; 2000 characters; plaintext-v1. Every app already in the
    // stores sends a group chat line through this route, so it is accepted here under exactly those rules.
    const directConv = db.prepare("SELECT type FROM conversations WHERE id=?").get(conversationId) as any;
    if (visitor && directConv && directConv.type !== 'dm') throw new MessagingError(VISITOR_SEND_REFUSAL);
    if (directConv?.type === GROUP_THREAD_TYPE) {
        try {
            const m = postGroupThreadMessageFromSendRoute(cb, conversationId, authorPubkey, ciphertext, nonce, type, !!attachment?.data, clientId, metadata);
            return { id: m.id, conversationId: m.conversationId, authorPubkey: m.authorPubkey, ciphertext: m.ciphertext, nonce: m.nonce, type: m.type, metadata: m.metadata, timestamp: m.timestamp };
        } catch (e: any) {
            throw toGroupChatMessagingError(e);
        }
    }
    // An enterprise thread is written only through its own route (engine/enterprise-thread.ts), which applies
    // the read-only state after wind-up, the frozen-author block, the 2000-character cap and plaintext text
    // only. No participant row is authority to post here (PR #924 review, B1).
    if (directConv?.type === 'enterprise_thread') throw new MessagingError(ENTERPRISE_THREAD_SEND_ERROR, 403);
    // A conversation kept for its opener alone, because the other had blocked them (engine/withheld-lines.ts): a DM
    // between the two as far as every rule below goes, a visitor's too (a member of another community, relayed by a
    // peer). Only its owner writes in it; to anyone else it is an id nobody has.
    const kept = !directConv ? withheldConversationOwnedBy(conversationId, authorPubkey) : undefined;
    let effectiveConvId = conversationId;
    let participants = kept
        ? [{ public_key: kept.owner_pubkey }, { public_key: kept.other_pubkey }]
        : db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(effectiveConvId) as any[];

    // If not found directly, check if conversationId was consolidated into an active DM
    if (!kept && (!participants.length || !participants.find(p => p.public_key === authorPubkey))) {
        try {
            const consolidatedId = consolidatedConversationOf(conversationId);
            if (consolidatedId) {
                effectiveConvId = consolidatedId;
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

    const targetConv = kept ? { type: 'dm' } : db.prepare("SELECT type FROM conversations WHERE id=?").get(effectiveConvId) as any;
    if (visitor && (targetConv?.type !== 'dm' || !participants.some(p => p.public_key === authorPubkey))) {
        throw new MessagingError(VISITOR_SEND_REFUSAL);
    }
    if (!participants.length || !participants.find(p => p.public_key === authorPubkey)) return null;

    // An event chat is written through POST /api/marketplace/posts/:id/chat/message, which re-checks the
    // RSVP, applies the 2000-character cap and refuses once the event has ended or been cancelled. The
    // participants mirror alone is not authority to post (docs/events-on-the-map.md §2.2).
    if (targetConv?.type === 'event_thread') throw new MessagingError(EVENT_THREAD_SEND_ERROR, 403);
    if (targetConv?.type === 'enterprise_thread') throw new MessagingError(ENTERPRISE_THREAD_SEND_ERROR, 403);

    if (clientId) {
        // A withheld line is answered again on a retry as a stored one is, so the retry tells its sender nothing.
        const existing = storedLineWithId(clientId);
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

    // Everything that reaches this store is a direct conversation's: a group chat returned above, an event or
    // enterprise chat was refused. So a member's words — the text and a photo alike — go in encrypted or not at
    // all. Checked after the participant check, so an outsider learns nothing from it, and after the idempotent
    // retry above, which stores nothing new.
    if (!opts.nodeAuthored) {
        refuseUnencryptedDm(ciphertext, nonce);
        if (attachment?.data) refuseUnencryptedDm(attachment.data, attachment.nonce);
        // A tombstone is written only by the node (message-tombstone.ts), never sent: a client's `removed`, `removedBy`,
        // `removedAt` and `accountDeleted` would pose its line as one (#1407 review: a phone read it as a deleted account).
        metadata = withoutTombstoneKeys(metadata);
    }
    opts.beforeStore?.({ ciphertext, metadata });

    const participantKeys = participants.map(p => p.public_key as string);
    // Someone in it has blocked the author (engine/member-blocks.ts): the line is kept for the author alone
    // (engine/withheld-lines.ts) and answered exactly as a stored one is, after every refusal and limit above, so the
    // block isn't revealed. Nothing goes in `messages`, nobody else's socket hears it, and no push or badge comes of it.
    // The node's own words (nodeAuthored) are never withheld.
    if (!opts.nodeAuthored && participantKeys.some(pk => pk !== authorPubkey && hasBlocked(pk, authorPubkey))) {
        const withheld: Message = {
            id: clientId || crypto.randomUUID(),
            conversationId: effectiveConvId,
            authorPubkey,
            ciphertext,
            nonce,
            type,
            metadata,
            timestamp: new Date().toISOString()
        };
        storeWithheldLine(withheld, attachment);
        cb.broadcast({ type: 'new_message', conversationId: effectiveConvId, message: withheld, participants: participantKeys }, [authorPubkey]);
        // The work a stored line's push does after its answer (the recipient's preferences, tokens, badge count over all
        // their chats, the signed notice), done all the same and dropped before it is kept or sent: the load on the node
        // after the answer is then the same either way, so the sender's next request can't tell (#1403 re-review).
        const withheldConvId = effectiveConvId;
        setImmediate(() => {
            try {
                const senderName = (getMember(db, authorPubkey) as any)?.callsign || 'A member';
                cb.rehearsePushNotification?.(
                    unmutedRecipients(withheldConvId, participantKeys),
                    authorPubkey,
                    '💬 New Message',
                    `${senderName} sent you a message`,
                    { screen: 'chat', conversationId: withheldConvId },
                    'chat',
                    'chat.message'
                );
            } catch { /* nothing was owed */ }
        });
        return withheld;
    }
    // A withheld conversation its owner writes in once the block is lifted becomes the real one; the line goes there.
    if (kept) {
        effectiveConvId = promoteWithheldConversation(cb, kept, authorPubkey);
        // Only when the two had a real conversation already: the line was encrypted against the withheld id, which the
        // apps find here, as for a consolidated conversation's line.
        if (effectiveConvId !== conversationId) {
            let metaObj: any = {};
            try { metaObj = metadata ? JSON.parse(metadata) : {}; } catch { metaObj = {}; }
            if (!metaObj || typeof metaObj !== 'object' || Array.isArray(metaObj)) metaObj = {};
            if (!metaObj.originalConversationId) metaObj.originalConversationId = conversationId;
            metadata = JSON.stringify(metaObj);
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
        // The ciphertext goes to the image store and the row keeps the nonce, the mime and a key
        // (storage design §7). The node has never held the key that would decrypt either half, so nothing
        // about what it can read changes; only where the 8 MB of it lives.
        // An id no key is built from (storage/image-store.ts idSegment refuses one, never strips it) keeps the
        // ciphertext in the row, as a store that refuses it does: a failure here never fails the message.
        let key: string | null = null;
        try { key = attachmentKey(msg.id); } catch { /* kept in the row */ }
        const cols = key ? storeAttachmentColumns(getImageStore(), key, attachment.data) : { data: attachment.data, storage_key: null };
        db.prepare(`INSERT INTO message_attachments (message_id, data, nonce, mime, storage_key) VALUES (?, ?, ?, ?, ?)`)
            .run(msg.id, cols.data, attachment.nonce, attachment.mime || 'image/jpeg', cols.storage_key);
    }

    // Only the conversation's participants — the people GET /api/messages/:id lets read it.
    cb.broadcast({ type: 'new_message', conversationId: effectiveConvId, message: msg, participants: participants.map(p => p.public_key) }, participants.map(p => p.public_key));

    // Node-readable threads never push per message; a DM does, unless the recipient muted it (decision 12).
    // After the answer, never inside it: the push's work (the recipient's preferences, tokens and badge count over all
    // their chats) would make a stored line's answer measurably slower than a withheld one's, which has no push, and
    // tell its sender they are blocked (#1403 review). A line's push never decided its answer.
    if (targetConv?.type !== 'enterprise_thread' && targetConv?.type !== 'event_thread') {
        const recipients = participants.map(p => p.public_key as string);
        const pushConvId = effectiveConvId;
        setImmediate(() => {
            try {
                const senderMember = getMember(db, authorPubkey) as any;
                // A push names people in words, never a slice of their key.
                const senderName = senderMember?.callsign || 'A member';
                cb.dispatchPushNotification(
                    unmutedRecipients(pushConvId, recipients),
                    authorPubkey,
                    '💬 New Message',
                    `${senderName} sent you a message`,
                    { screen: 'chat', conversationId: pushConvId },
                    'chat',
                    'chat.message'
                );
            } catch (e: any) {
                console.warn('[Push] A message push failed:', e?.message ?? e);
            }
        });
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
    if (!row) {
        // A withheld line (engine/withheld-lines.ts) takes its own author's reaction, heard on their own sockets only.
        // To anyone else it is an id nobody has.
        const own = ownWithheldLine(messageId, authorPubkey);
        if (!own) return null;
        if (own.type === 'removed') throw new MessagingError(MESSAGE_REMOVED_REACT_ERROR, 403);
        const toggled = JSON.stringify(toggledReactions(own.metadata, authorPubkey, emoji).metadata);
        setWithheldLineMetadata(own.id, toggled);
        cb.broadcast({ type: 'message_reaction', conversationId: own.conversation_id, messageId, metadata: toggled, participants: eventParticipants(own.conversation_id, authorPubkey) }, [authorPubkey]);
        return { success: true, metadata: toggled };
    }

    // An enterprise thread has no reactions, and nobody's participant row there is authority to write (B1).
    // Refused before the participant check: the thread is readable by members, so this hides nothing.
    const convType = db.prepare("SELECT type FROM conversations WHERE id=?").get(row.conversation_id) as any;
    if (convType?.type === 'enterprise_thread') throw new MessagingError(ENTERPRISE_THREAD_REACT_ERROR, 403);
    // A line of an event chat whose event isn't there for this caller (a hidden group's event, one they were removed
    // from or left while Going) answers as an id nobody has, before the participants mirror, where a removed member
    // keeps their seat: "Reactions are not part of an event chat" would confirm the line is real (the #828 rule).
    if (convType?.type === 'event_thread' && eventChatUnknownTo(row.conversation_id, authorPubkey)) return null;

    const participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(row.conversation_id) as any[];

    if (convType?.type === GROUP_THREAD_TYPE) {
        // A group chat reacts exactly as a DM does (chat parity), under the group's own write rule: whoever may
        // post there may react there. The participants mirror is never the authority — group_members is.
        // Who may SEE the chat is settled first (PR #1048 review): an invite-only group the caller has no live
        // row in returns null, which this route answers with the same 404 as an id nobody has, rather than the
        // write rule's 403 — which would confirm the id is a real message in a hidden group (the #828 rule).
        const refusal = groupChatRefusal(row.conversation_id, authorPubkey);
        if (refusal?.status === 404) return null;
        if (refusal) throw new MessagingError(refusal.error, refusal.status);
        if (row.type === 'system') throw new MessagingError(GROUP_CHAT_SYSTEM_REACT_ERROR, 400);
        try { assertCanWriteInGroupChat(row.conversation_id, authorPubkey); }
        catch (e: any) { throw toGroupChatMessagingError(e); }
    } else {
        // A visitor's row reacts in a direct conversation it is in (isVisitorsDirectLine). A participant row it holds in any
        // other chat is from before visitors were refused one, and there it is answered as a key with no row is.
        const visitorsDirectLine = isVisitorsDirectLine(messageId, authorPubkey);
        if (!participants.some((p: any) => p.public_key === authorPubkey)
            || (!visitorsDirectLine && isLiveVisitor(db, authorPubkey))) {
            return null;
        }
        // A participant row outlasts a prune and a pending re-key; a reaction still reaches the other person.
        if (!visitorsDirectLine && !isNodeMember(db, authorPubkey)) throw new MessagingError(NOT_A_MEMBER_ERROR, 403, NOT_A_MEMBER_CODE);
        // An event chat carries text the host can remove and nothing else, and it is read-only once the event
        // ends — a reaction would be a write this route cannot rule on.
        if (convType?.type === 'event_thread') throw new MessagingError(EVENT_THREAD_REACT_ERROR, 403);
    }

    // A tombstone takes no reactions, in any chat: the message it stood for is gone.
    if (row.type === 'removed') throw new MessagingError(MESSAGE_REMOVED_REACT_ERROR, 403);

    // The line as this member sees it: with their own reaction from while they were blocked, if they made one
    // (engine/withheld-lines.ts withheld_overlays), which only they see.
    const overlay = overlayOf(messageId, authorPubkey);
    const seen = overlay?.reaction ? withOwnReaction(row.metadata, authorPubkey, overlay.reaction) : row.metadata;
    const { metadata, removed } = toggledReactions(seen, authorPubkey, emoji);
    const metadataStr = JSON.stringify(metadata);
    const keys = participants.map((p: any) => p.public_key as string);
    const toAuthorOnly = () => {
        // As a stored reaction is heard, the conversation's participants named, on the author's own sockets alone.
        cb.broadcast({ type: 'message_reaction', conversationId: row.conversation_id, messageId, metadata: metadataStr, participants: keys }, [authorPubkey]);
        return { success: true, metadata: metadataStr };
    };
    // In a DM with someone who has blocked them, a reaction is up to 32 characters of anything on the other person's
    // screen (engine/member-blocks.ts): kept for its author alone and laid over their own reads (#1403 review), so it is
    // there on their next read, as anyone's is, and never in the line the other person sees. Taking theirs back from the
    // line itself still goes through.
    if (!removed && convType?.type === 'dm' && keys.some(pk => pk !== authorPubkey && hasBlocked(pk, authorPubkey))) {
        setOverlayReaction(messageId, authorPubkey, emoji);
        return toAuthorOnly();
    }
    if (overlay?.reaction) {
        setOverlayReaction(messageId, authorPubkey, null);
        // The one they took back was only ever theirs to see: the line nobody else sees changes in nothing.
        if (removed && !reactionsOf(row.metadata).some((r: any) => r?.author === authorPubkey)) return toAuthorOnly();
    }
    db.prepare("UPDATE messages SET metadata=? WHERE id=?").run(metadataStr, messageId);

    cb.broadcast({
        type: 'message_reaction',
        conversationId: row.conversation_id,
        messageId,
        metadata: metadataStr,
        participants: keys
    }, keys);

    return { success: true, metadata: metadataStr };
}

/** A line's stored reactions, whatever its metadata holds. */
function reactionsOf(stored: string | null | undefined): any[] {
    try {
        const m = stored ? JSON.parse(stored) : null;
        return Array.isArray(m?.reactions) ? m.reactions : [];
    } catch {
        return [];
    }
}

/** Who a conversation's live events name: its participants, or the two of a withheld conversation (engine/withheld-lines.ts). */
function eventParticipants(conversationId: string, author: string): string[] {
    const real = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(conversationId) as { public_key: string }[];
    if (real.length > 0) return real.map(p => p.public_key);
    const kept = withheldConversationOwnedBy(conversationId, author);
    return kept ? [kept.owner_pubkey, kept.other_pubkey].sort() : [author];
}

/**
 * A line's metadata with `author`'s reaction toggled: the same emoji again takes theirs away (`removed`), another
 * replaces it, and none adds it.
 */
function toggledReactions(stored: string | null | undefined, author: string, emoji: string): { metadata: any; removed: boolean } {
    let metadata: any = {};
    if (stored) {
        try {
            metadata = JSON.parse(stored);
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

    let removed = false;
    const existingIndex = metadata.reactions.findIndex((r: any) => r.author === author);
    if (existingIndex > -1) {
        const existingReaction = metadata.reactions[existingIndex];
        if (existingReaction.emoji === emoji) {
            metadata.reactions.splice(existingIndex, 1);
            removed = true;
        } else {
            metadata.reactions[existingIndex].emoji = emoji;
        }
    } else {
        metadata.reactions.push({ emoji, author });
    }
    return { metadata, removed };
}

export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;
/** What an id nobody has is answered with — and, word for word, what a message in a group chat the caller
 *  may not see is answered with, so the two cannot be told apart (the #828 rule). */
export const MESSAGE_NOT_FOUND_ERROR = 'Message not found';
export const MESSAGE_REMOVED_EDIT_ERROR = 'A removed message cannot be edited';
export const MESSAGE_REMOVED_REACT_ERROR = 'A removed message cannot be reacted to';
export const MESSAGE_DELETE_NOT_AUTHOR_ERROR = 'Only the author can delete a message';
export const SYSTEM_MESSAGE_DELETE_ERROR = 'System messages cannot be deleted';
export const THREAD_MESSAGE_DELETE_ERROR = 'Messages in an enterprise discussion thread cannot be deleted';
export const EVENT_THREAD_DELETE_ERROR = 'Messages in an event chat cannot be deleted';
export const THREAD_MESSAGE_EDIT_ERROR = 'Messages in an enterprise discussion thread cannot be edited';
export const EVENT_THREAD_EDIT_ERROR = 'Messages in an event chat cannot be edited';
export const EVENT_THREAD_SEND_ERROR = 'Post to an event chat through the event, not this route';
export const EVENT_THREAD_REACT_ERROR = 'Reactions are not part of an event chat';
export const ENTERPRISE_THREAD_SEND_ERROR = "Post to an enterprise's discussion through the enterprise, not this route";
export const ENTERPRISE_THREAD_REACT_ERROR = 'Reactions are not part of an enterprise discussion';

/**
 * Does this id name a line in a Commons group's chat? The write routes ask before they act, so that changing a
 * line in a room that pushes to every member is throttled exactly as posting one there is (PR #1048 review).
 * An id nobody has and a DM message both answer false, so the answer itself tells a caller nothing — the only
 * thing it changes is which bucket the request is counted in.
 */
export function isGroupChatMessage(messageId: unknown): boolean {
    if (typeof messageId !== 'string' || !messageId) return false;
    return !!db.prepare(
        "SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.type = ?"
    ).get(messageId, GROUP_THREAD_TYPE);
}

export function editMessage(
    cb: MessagingCallbacks,
    messageId: string,
    authorPubkey: string,
    ciphertext: string,
    nonce: string,
    /**
     * A caller's own limit on the new words (the edit route's 64 KB, W-main): run once every refusal below has passed
     * (a thread or event chat's line, someone else's, a removed one, past the 15 minutes) and just before the row is
     * changed, so a limit never answers for a caller who may not edit this message at all.
     */
    beforeStore?: () => void
): Message {
    assertMemberActive(authorPubkey);
    refuseVisitorOutsideItsDirectConversations(messageId, authorPubkey);
    const row = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId) as any;
    if (!row) {
        // A withheld line (engine/withheld-lines.ts): its author edits it as any DM line of theirs, under the same rules,
        // heard on their own sockets only. Anyone else's edit of it is refused as a real line's is: only the author may
        // (#1403 re-review: "not found" would tell a second account that the id is a withheld one).
        const own = ownWithheldLine(messageId, authorPubkey);
        if (!own) {
            if (withheldLine(messageId)) throw new MessagingError('You are not a participant in this conversation', 403);
            throw new MessagingError(MESSAGE_NOT_FOUND_ERROR, 404);
        }
        if (own.type === 'removed') throw new MessagingError(MESSAGE_REMOVED_EDIT_ERROR, 403);
        refuseUnencryptedDm(ciphertext, nonce);
        const sentMs = new Date(own.timestamp).getTime();
        if (Number.isNaN(sentMs) || Date.now() - sentMs > MESSAGE_EDIT_WINDOW_MS) {
            throw new MessagingError('Messages can only be edited within 15 minutes of sending');
        }
        beforeStore?.();
        const editedAt = new Date().toISOString();
        editWithheldLine(own.id, ciphertext, nonce, editedAt);
        const edited: Message = { ...withheldLineMessage(own), ciphertext, nonce, editedAt };
        delete edited.updatedAt;
        cb.broadcast({ type: 'message_edited', conversationId: own.conversation_id, message: edited, participants: eventParticipants(own.conversation_id, authorPubkey) }, [authorPubkey]);
        return edited;
    }
    // Enterprise discussion-thread messages are not editable. This route has no size bound
    // and knows nothing of thread moderation or a wound-up enterprise's read-only thread.
    // Fails closed: a message whose conversation row is missing cannot be shown to be outside a thread.
    const conv = db.prepare("SELECT type FROM conversations WHERE id=?").get(row.conversation_id) as any;
    if (!conv) throw new MessagingError('Conversation not found', 404);
    if (conv.type === 'enterprise_thread') throw new MessagingError(THREAD_MESSAGE_EDIT_ERROR, 403);
    // An event chat is moderated by its host and goes read-only when the event ends; this route knows
    // neither, so it refuses (docs/events-on-the-map.md §2.2). Someone the event isn't there for (a hidden group's
    // event, or one they were removed from or left) is answered first, as an id nobody has (the #828 rule).
    if (conv.type === 'event_thread') {
        if (eventChatUnknownTo(row.conversation_id, authorPubkey)) throw new MessagingError(MESSAGE_NOT_FOUND_ERROR);
        throw new MessagingError(EVENT_THREAD_EDIT_ERROR, 403);
    }

    const isGroupChat = conv.type === GROUP_THREAD_TYPE;
    // Whether this caller may SEE the chat at all is settled BEFORE the author match and before anything else
    // that depends on this particular message (PR #1048 review). An invite-only group answers an outsider
    // exactly as an id nobody has — same status, same words (the #828 rule) — so 'Only the author can edit a
    // message' can never be the thing that confirms a real message id inside a chat they cannot see.
    if (isGroupChat) {
        const refusal = groupChatRefusal(row.conversation_id, authorPubkey);
        if (refusal) throw refusal.status === 404
            ? new MessagingError(MESSAGE_NOT_FOUND_ERROR)
            : new MessagingError(refusal.error, refusal.status);
    } else if (!db.prepare("SELECT 1 FROM conversation_participants WHERE conversation_id=? AND public_key=?")
        .get(row.conversation_id, authorPubkey)) {
        throw new MessagingError('You are not a participant in this conversation', 403);
    }
    if (row.author_pubkey !== authorPubkey) throw new MessagingError('Only the author can edit a message');
    if (row.type === 'system') throw new MessagingError('System messages cannot be edited');
    // A keeper-removed message is a tombstone: never editable, by any route.
    if (row.type === 'removed') throw new MessagingError(MESSAGE_REMOVED_EDIT_ERROR, 403);
    // An edit is new words: in a direct conversation, encrypted or not at all (see sendMessage).
    if (!isGroupChat) refuseUnencryptedDm(ciphertext, nonce);

    // A group chat is editable under the group's own rules (chat parity, 2026-09-23 — slice 1 refused it here
    // because this route had no size bound and no membership re-check; it has both now, from the engine the
    // group send uses). The two things slice 1 was missing, applied before anything is written — the write
    // rule (an observer reads but does not post) on top of the read rule checked above:
    let storedCiphertext = ciphertext;
    let storedNonce = nonce;
    if (isGroupChat) {
        try {
            assertCanWriteInGroupChat(row.conversation_id, authorPubkey);
            storedCiphertext = groupChatEditedCiphertext(ciphertext, nonce);
            storedNonce = 'plaintext-v1';
        } catch (e: any) {
            throw toGroupChatMessagingError(e);
        }
    }

    const sentAtMs = new Date(row.timestamp).getTime();
    if (Number.isNaN(sentAtMs) || Date.now() - sentAtMs > MESSAGE_EDIT_WINDOW_MS) {
        throw new MessagingError('Messages can only be edited within 15 minutes of sending');
    }
    beforeStore?.();

    const editedAt = new Date().toISOString();
    const participants = isGroupChat ? [] : db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(row.conversation_id) as any[];
    // An edit is new words on the other person's screen: in a DM with someone who has blocked its author, kept for the
    // author alone and laid over their own reads of the line (engine/withheld-lines.ts withheld_overlays; #1403 review),
    // as a new line is withheld, so their next read shows it as made and the other person's never does.
    const withheld = !isGroupChat && participants.some((p: any) => p.public_key !== authorPubkey && hasBlocked(p.public_key, authorPubkey));
    if (withheld) {
        setOverlayEdit(messageId, authorPubkey, storedCiphertext, storedNonce, editedAt);
    } else {
        db.prepare("UPDATE messages SET ciphertext=?, nonce=?, edited_at=? WHERE id=?").run(storedCiphertext, storedNonce, editedAt, messageId);
        // An edit from while they were blocked, still over their own read, gives way to this one.
        if (!isGroupChat) clearOverlayEdit(messageId, authorPubkey);
    }

    const updated: Message = {
        id: row.id,
        conversationId: row.conversation_id,
        authorPubkey: row.author_pubkey,
        ciphertext: storedCiphertext,
        nonce: storedNonce,
        type: row.type,
        systemType: row.system_type,
        metadata: row.metadata,
        timestamp: row.timestamp,
        editedAt
    };

    // A group chat's live update is the chat's own, the way a removal already reaches it; a DM keeps
    // `message_edited`. Neither pushes: an edit never notifies, and an edited text raises no new @mention.
    if (isGroupChat) {
        broadcastGroupChatUpdate(cb, row.conversation_id, messageId, 'edited');
        return updated;
    }
    if (withheld) {
        // Heard on the author's own sockets alone, as a stored edit is heard, with the line as they see it.
        const seen = withOwnOverlay({ ...updated }, authorPubkey);
        cb.broadcast({ type: 'message_edited', conversationId: row.conversation_id, message: { ...seen, ciphertext: storedCiphertext, nonce: storedNonce, editedAt },
            participants: participants.map((p: any) => p.public_key) }, [authorPubkey]);
        return { ...updated, metadata: seen.metadata };
    }

    cb.broadcast({
        type: 'message_edited',
        conversationId: row.conversation_id,
        message: updated,
        participants: participants.map(p => p.public_key)
    }, participants.map(p => p.public_key));

    return updated;
}

/**
 * Delete for everyone (chat parity, 2026-09-23). The signer must be the message's AUTHOR; unlike an edit there
 * is no window, because a message you regret is usually one you regret later. Works in a DM and in a group
 * chat, and only while the author can still read that chat — nobody reaches into a room they have left.
 *
 * Enterprise and event threads are unchanged this round: their own routes own removal there.
 *
 * The row becomes a tombstone (engine/message-tombstone.ts), so it cannot be edited or reacted to afterwards,
 * and deleting twice is a no-op success that keeps whoever took it down first on the record. A convenor's
 * `POST /api/groups/:id/chat/remove` is the other way a message goes down, and stays exactly as it was; the
 * apps tell them apart by `metadata.removedBy`.
 */
export function deleteOwnMessage(
    cb: MessagingCallbacks,
    messageId: string,
    authorPubkey: string
): Message {
    assertMemberActive(authorPubkey);
    refuseVisitorOutsideItsDirectConversations(messageId, authorPubkey);
    const row = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId) as any;
    if (!row) {
        // A withheld line (engine/withheld-lines.ts): its author takes it down as any DM line of theirs, to the same
        // tombstone, heard on their own sockets only. Anyone else is refused as a non-participant of a real DM is
        // (#1403 re-review: "not found" would tell a second account that the id is a withheld one).
        const own = ownWithheldLine(messageId, authorPubkey);
        if (!own) {
            if (withheldLine(messageId)) throw new MessagingError('You are not a participant in this conversation', 403);
            throw new MessagingError(MESSAGE_NOT_FOUND_ERROR, 404);
        }
        // A withheld line has no system type: null, as a stored line's answer has it, so the two answers have one shape.
        if (own.type === 'removed') return { ...toMessage(own), systemType: null as any };
        const { ciphertext, metadata } = tombstoneFields(own, authorPubkey, GROUP_THREAD_DELETED_TEXT);
        tombstoneWithheldLine(own.id, ciphertext, metadata);
        const gone: Message = { ...toMessage(own), systemType: null as any, ciphertext, nonce: 'plaintext-v1', type: 'removed', metadata };
        cb.broadcast({ type: 'message_edited', conversationId: own.conversation_id, message: gone, participants: eventParticipants(own.conversation_id, authorPubkey) }, [authorPubkey]);
        return gone;
    }
    // Fails closed, as the edit does: a message whose conversation row is missing cannot be shown to be
    // outside a thread this route may not write to.
    const conv = db.prepare("SELECT type FROM conversations WHERE id=?").get(row.conversation_id) as any;
    if (!conv) throw new MessagingError('Conversation not found', 404);
    if (conv.type === 'enterprise_thread') throw new MessagingError(THREAD_MESSAGE_DELETE_ERROR, 403);
    // An event chat's line: first answered as an id nobody has for someone the event isn't there for, as the edit is.
    if (conv.type === 'event_thread') {
        if (eventChatUnknownTo(row.conversation_id, authorPubkey)) throw new MessagingError(MESSAGE_NOT_FOUND_ERROR, 404);
        throw new MessagingError(EVENT_THREAD_DELETE_ERROR, 403);
    }

    const isGroupChat = conv.type === GROUP_THREAD_TYPE;
    // Who may SEE this chat comes FIRST — before the author match, and before the system-line refusal, both of
    // which describe the message itself (PR #1048 review). Still able to READ the chat is the bar, not still
    // able to post: an observer may take down the line they wrote while they were a member. An invite-only group
    // answers someone with no live row in it exactly as an id nobody has — the same 404, the same words (the
    // #828 rule) — so no refusal here can confirm that a hidden group's message id is real.
    if (isGroupChat) {
        const refusal = groupChatRefusal(row.conversation_id, authorPubkey);
        if (refusal) throw refusal.status === 404
            ? new MessagingError(MESSAGE_NOT_FOUND_ERROR, 404)
            : new MessagingError(refusal.error, refusal.status);
    } else if (!db.prepare("SELECT 1 FROM conversation_participants WHERE conversation_id=? AND public_key=?")
        .get(row.conversation_id, authorPubkey)) {
        throw new MessagingError('You are not a participant in this conversation', 403);
    }

    // A system line's author is 'SYSTEM', so "only the author" would refuse it for the wrong reason and tell a
    // caller nothing about why a join line will not go away — hence before the author check, after the one above.
    if (row.type === 'system') throw new MessagingError(SYSTEM_MESSAGE_DELETE_ERROR, 400);
    if (row.author_pubkey !== authorPubkey) throw new MessagingError(MESSAGE_DELETE_NOT_AUTHOR_ERROR, 403);

    if (row.type === 'removed') {
        // Idempotent: already a tombstone, whoever made it. Answered as a success with the message as it is.
        return toMessage(row);
    }

    const { ciphertext, metadata } = writeMessageTombstone(messageId, row, authorPubkey, GROUP_THREAD_DELETED_TEXT);
    // Nothing is laid over a tombstone: anyone's withheld reaction or edit on the line goes with it (engine/withheld-lines.ts).
    dropOverlaysOn(messageId);
    const updated: Message = {
        ...toMessage(row),
        ciphertext,
        nonce: 'plaintext-v1',
        type: 'removed',
        metadata,
    };

    // Live, never a push. A group chat hears it as a removal, exactly as a convenor's removal reaches it; a DM
    // hears `message_edited` carrying the tombstone, which is how both phones replace the ciphertext they hold.
    if (isGroupChat) {
        broadcastGroupChatUpdate(cb, row.conversation_id, messageId, 'removed');
        return updated;
    }
    const participants = db.prepare("SELECT public_key FROM conversation_participants WHERE conversation_id=?").all(row.conversation_id) as any[];
    cb.broadcast({
        type: 'message_edited',
        conversationId: row.conversation_id,
        message: updated,
        participants: participants.map(p => p.public_key)
    }, participants.map(p => p.public_key));
    return updated;
}

/** One stored `messages` row as the wire shape. */
function toMessage(row: any): Message {
    return {
        id: row.id,
        conversationId: row.conversation_id,
        authorPubkey: row.author_pubkey,
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        type: row.type,
        systemType: row.system_type,
        metadata: row.metadata,
        timestamp: row.timestamp,
        editedAt: row.edited_at,
    };
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
        [SystemMessageType.ESCROW_DISPUTE_RESOLVED]: `Dispute arbitrated by ${meta.resolvedByName || 'a community admin'}: ${
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
    // Bad input from the caller, not a refusal of who they are: an empty or oversized edit, a nonce that is not
    // plaintext-v1, a reply that names a message in another chat or a system line.
    if (/empty|too long|plain text|Only text|not in this chat|system line/.test(msg)) return new MessagingError(msg, 400);
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
            // Tombstones before caches: the rows go now, the objects once this transaction has committed.
            const doomedObjects = (db.prepare(
                'SELECT storage_key FROM message_attachments WHERE storage_key IS NOT NULL AND message_id IN (SELECT id FROM messages WHERE conversation_id = ?)'
            ).all(id) as any[]).map(r => r.storage_key as string);
            db.prepare('DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)').run(id);
            if (doomedObjects.length > 0) afterTransactionCommit(() => deleteStoredObjects(db, doomedObjects));
            db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
            db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ?').run(id);
            deletePlainRows('chat_mutes', 'conversation_id = ?', id);
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
    // A trade's chat is the node's: a block never withholds it, or a deal under way would lose its notices.
    const conv = createConversation(cb, 'dm', [buyerPubkey, sellerPubkey], buyerPubkey, undefined, undefined, { asNode: true });
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
                    const targetConv = createConversation(cb, 'dm', [parts[0].public_key, parts[1].public_key], parts[0].public_key, undefined, undefined, { asNode: true });
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
