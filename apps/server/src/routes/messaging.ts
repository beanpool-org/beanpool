/**
 * Messaging routes — Conversations, DMs, Attachments, Reactions, mutes. A Commons group's chat is served by
 * routes/groups.ts; the reads and writes here re-check group membership for it.
 */

import Router from '@koa/router';
import {
    createConversation, sendMessage, editMessage, deleteOwnMessage,
    getConversationsByMember, toggleMessageReaction,
    getConversationMessages, getConversation,
    markConversationRead, getUnreadCounts,
    getMember,
} from '../state-engine.js';
import { MessagingError, CHAT_GROUP_REMOVED_ERROR, isGroupChatMessage } from '../engine/messaging.js';
import { canReadEventThread, loadEventForThread, isEventThreadExpired, eventHiddenFrom, EVENT_CHAT_GONE } from '../engine/event-thread.js';
import { GROUP_THREAD_TYPE, groupChatRefusal, syncGroupThreadMembership } from '../engine/group-thread.js';
import { isKeeperOfEnterprise, markKeeperThreadRead } from '../engine/enterprise-thread.js';
import { setChatMute, clearChatMute, getChatMutesFor, isChatMuteDuration } from '../engine/chat-mutes.js';
import { getLocalConfig } from '../config/local-config.js';
import { getConnectorByPublicUrl } from '../connector-manager.js';
import { federatedRelayMessage } from '../federation-protocol.js';
import { getP2PNode } from '../p2p.js';
import { chatRateLimit } from '../chat-rate-limit.js';
import { assertNotMuted } from '../engine/auto-moderation.js';
import { assertMayMessage } from '../engine/probation.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import type { RouteDeps } from './types.js';

/** May this member mute this chat? For an event chat and a DM, the same rules as reading it. An enterprise's
 *  thread is readable by any member (it is public), but only its keepers get it in "Your groups", so only they may
 *  mute it. A group chat goes through groupChatRefusal instead, which also says whether to answer 403 or 404. */
function canOpenChat(conv: { id: string; type: string; participants: string[] }, actor: string): boolean {
    if (conv.type === 'enterprise_thread') return isKeeperOfEnterprise(actor, conv.id);
    if (conv.type === 'event_thread') {
        try {
            const row = loadEventForThread(conv.id);
            return !isEventThreadExpired(row) && canReadEventThread(row, actor);
        } catch { return false; }
    }
    return conv.participants.includes(actor);
}

/**
 * Refuse a caller who may not open this group's chat, answering exactly as for an id that does not exist when the
 * group is invite-only and the caller has no invitation or request (PR #924 review, item 5): same status, same
 * words, so the ordinary routes cannot be used to learn that a hidden group exists. Returns true when refused.
 */
function refuseGroupChat(ctx: any, groupId: string, actor: string | undefined, notFound: { status: number; error: string }): boolean {
    const refusal = groupChatRefusal(groupId, actor);
    if (!refusal) return false;
    ctx.status = refusal.status === 404 ? notFound.status : refusal.status;
    ctx.body = { error: refusal.status === 404 ? notFound.error : refusal.error };
    return true;
}

function eventChatHiddenFrom(conversationId: string, pubkey: string | undefined): boolean {
    try { return eventHiddenFrom(loadEventForThread(conversationId), pubkey); } catch { return false; }
}

const CONVERSATION_NOT_FOUND = { status: 404, error: 'Conversation not found' };
const SEND_NOT_FOUND = { status: 400, error: 'Failed to send — conversation not found or not a participant' };

export function createMessagingRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { clampLimit, clampOffset, enforceReadAuth: ENFORCE_READ_AUTH } = deps;

// ===================== MESSAGING API (PUBLIC) =====================

/** Ed25519 public keys are 64 hex characters; 128 leaves room without allowing a
 *  megabyte of text to reach the members lookup. */
const MAX_PARTICIPANT_KEY_LENGTH = 128;

/**
 * Answer a thrown messaging error. An expected refusal (MessagingError) keeps its 4xx and message. Anything
 * else is a server fault: 500 with a generic message, logged here, so clients retry rather than treat a
 * locked database as a permanent refusal, and driver text is never echoed (#672).
 */
function respondToMessagingError(ctx: any, e: unknown, what: string): void {
    if (e instanceof MessagingError) {
        ctx.status = e.status;
        ctx.body = { error: e.message };
        return;
    }
    console.error(`[Messaging] ${what} failed unexpectedly:`, (e as any)?.message || e);
    ctx.status = 500;
    ctx.body = { error: `Could not ${what} because of a server problem. Please try again.` };
}

router.post('/api/messages/conversation', async (ctx) => {
    const { type, participants, createdBy, name } = (ctx as any).requestBody || {};
    if (!type || !participants || !createdBy) {
        ctx.status = 400;
        ctx.body = { error: 'type, participants, and createdBy are required' };
        return;
    }
    // The old chat group was removed (groups decision 2, 2026-09-19). An app still offering it gets a plain
    // 410 saying where group chats live now, not a crash. conversations.type has no CHECK constraint, so any
    // other string is refused here before the length rules below: type "bulk" with 5,000 participants once
    // took the exclusive write lock for 5,000 INSERTs.
    if (type === 'group') {
        ctx.status = 410;
        ctx.body = { error: CHAT_GROUP_REMOVED_ERROR };
        return;
    }
    if (type !== 'dm') {
        ctx.status = 400;
        ctx.body = { error: 'type must be "dm"' };
        return;
    }
    if (!Array.isArray(participants)) {
        ctx.status = 400;
        ctx.body = { error: 'participants must be an array' };
        return;
    }
    if (!participants.every((p: unknown) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PARTICIPANT_KEY_LENGTH)) {
        ctx.status = 400;
        ctx.body = { error: 'All participants must be valid public keys' };
        return;
    }
    // conversation_participants is keyed on (conversation_id, public_key), so a repeated
    // participant made the INSERT loop throw UNIQUE constraint failed and surfaced the raw
    // SQLite error to the caller. De-duplicate and count distinct people.
    const uniqueParticipants: string[] = Array.from(new Set<string>(participants));
    if (uniqueParticipants.length !== 2) {
        ctx.status = 400;
        ctx.body = { error: 'DM conversations must have exactly 2 distinct participants' };
        return;
    }
    // A2-15: the creator (bound to the verified signer by the spoof check) must
    // be one of the participants. Otherwise a member could fabricate a thread
    // between OTHER people (a DM "between B and C")
    // and inject it into victims' inboxes with an arbitrary name. Enforced at
    // this public route only — internal/system conversation creation
    // (ensureTransactionConversation, injectSystemMessage) calls
    // createConversation directly with a system actor and is unaffected.
    if (!uniqueParticipants.includes(createdBy)) {
        ctx.status = 403;
        ctx.body = { error: 'Creator must be a participant of the conversation' };
        return;
    }
    try {
        // G3, global profile: a muted member starts no conversations (403); a new account starts them with at most
        // 10 new people a day (429). Starting one is a line in the other person's inbox, even before a message.
        assertNotMuted(createdBy);
        for (const other of uniqueParticipants) if (other !== createdBy) assertMayMessage(createdBy, other);
        const conv = createConversation('dm', uniqueParticipants, createdBy, name);
        if (!conv) {
            ctx.status = 400;
            ctx.body = { error: 'Failed to create conversation — check all participants are registered' };
            return;
        }
        ctx.body = { success: true, conversation: conv };
    } catch (e: any) {
        if (respondProfileRefusal(ctx, e)) return;
        respondToMessagingError(ctx, e, 'create the conversation');
    }
});

router.post('/api/messages/send', async (ctx) => {
    const { conversationId, authorPubkey, ciphertext, nonce, type, attachment, metadata, id } = (ctx as any).requestBody || {};
    if (!conversationId || !authorPubkey || !ciphertext || !nonce) {
        ctx.status = 400;
        ctx.body = { error: 'conversationId, authorPubkey, ciphertext, and nonce are required' };
        return;
    }
    if (ctx.state.actor && ctx.state.actor !== authorPubkey) {
        ctx.status = 403;
        ctx.body = { error: 'authorPubkey must match authenticated signer' };
        return;
    }
    // Optional client-generated message id (see sendMessage). Strict UUID v4
    // only — anything else is rejected rather than silently ignored, so a
    // malformed id can't slip through as a server-generated one.
    let clientId: string | undefined;
    if (id !== undefined && id !== null) {
        if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
            ctx.status = 400;
            ctx.body = { error: 'id must be a UUID v4' };
            return;
        }
        clientId = id.toLowerCase();
    }
    // A group chat line is a row in a room that pushes to every member, so it is throttled exactly as the group
    // chat route throttles it — per signed member, in the chat bucket (PR #924 review, item 4) — and an
    // invite-only group is 404 to an outsider here as there (item 5). Store apps up to 1.2.37 send group chat
    // lines through this route.
    const target = getConversation(conversationId);
    if (target?.type === GROUP_THREAD_TYPE) {
        if (!chatRateLimit(ctx, ctx.state.actor)) return;
        if (refuseGroupChat(ctx, conversationId, authorPubkey, SEND_NOT_FOUND)) return;
    }
    let msg;
    try {
        // G3, global profile: a muted member sends nothing (403). A new account writes to at most 10 new people a
        // day in DMs (429); a reply, or anyone they have written to before, is never limited. An old conversation
        // id the engine remaps is a DM between two people who have talked already, so it is not checked here.
        assertNotMuted(authorPubkey);
        if (target?.type === 'dm' && target.participants.includes(authorPubkey)) {
            for (const other of target.participants) if (other !== authorPubkey) assertMayMessage(authorPubkey, other);
        }
        msg = sendMessage(conversationId, authorPubkey, ciphertext, nonce, type === 'image' ? 'image' : 'text', attachment, metadata, clientId);
    } catch (e: any) {
        if (respondProfileRefusal(ctx, e)) return;
        respondToMessagingError(ctx, e, 'send the message');
        return;
    }
    if (!msg) {
        ctx.status = SEND_NOT_FOUND.status;
        ctx.body = { error: SEND_NOT_FOUND.error };
        return;
    }

    // --- FEDERATION RELAY ---
    try {
        // Use the RESOLVED conversation id the message was actually stored under
        // (sendMessage may remap a legacy/consolidated conversationId to the active
        // DM). Looking up the raw request `conversationId` here would miss the
        // participants of a consolidated thread and silently skip cross-node relay.
        const conv = getConversation(msg.conversationId);
        if (conv && conv.type === 'dm') {
            const otherPubkey = conv.participants.find(p => p !== authorPubkey);
            if (otherPubkey) {
                const otherMember = getMember(otherPubkey);

                // If the other member has a homeNodeUrl, they are a visitor from a remote node
                if (otherMember && otherMember.homeNodeUrl) {
                    const p2pNode = getP2PNode();
                    if (p2pNode) {
                        const targetConnector = getConnectorByPublicUrl(otherMember.homeNodeUrl);
                        if (targetConnector && targetConnector.peerId) {
                            const localMember = getMember(authorPubkey);
                            const localConfig = getLocalConfig();
                            const hostname = process.env.CF_RECORD_NAME || (localConfig.communityName ? localConfig.communityName.toLowerCase().replace(/\s+/g, '') + '.beanpool.org' : undefined);
                            const localUrl = hostname ? `https://${hostname}` : undefined;

                            // Fire-and-forget over secure Libp2p mesh
                            federatedRelayMessage(p2pNode, targetConnector.peerId, {
                                senderPublicKey: authorPubkey,
                                senderCallsign: localMember?.callsign,
                                senderNodeUrl: localUrl,
                                recipientPublicKey: otherPubkey,
                                ciphertext,
                                nonce,
                                metadata
                            }).catch(e => console.warn('[Federation] Failed to relay message to remote peer:', e.message));
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('[Federation] Error during message relay:', e);
    }
    // -----------------------

    ctx.body = { success: true, message: msg };
});

router.post('/api/messages/edit', async (ctx) => {
    const { messageId, ciphertext, nonce } = (ctx as any).requestBody || {};
    // The author is the verified request signer (ctx.state.actor) — not a client-supplied
    // field — so nobody can edit someone else's message.
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    if (!messageId || !ciphertext || !nonce) {
        ctx.status = 400;
        ctx.body = { error: 'messageId, ciphertext, and nonce are required' };
        return;
    }
    // Changing a group chat line is a write into a room that pushes to every member, exactly as posting one is,
    // so it is throttled exactly as posting one is: per signed member, in the chat bucket the two send routes
    // share (PR #1048 review). A DM keeps the DM rules — its fan-out is the other phone.
    if (isGroupChatMessage(messageId) && !chatRateLimit(ctx, actor)) return;
    try {
        // An edit is new words in someone else's chat: a muted member (G3) can't make one.
        assertNotMuted(actor);
        const msg = editMessage(messageId, actor, ciphertext, nonce);
        ctx.body = { success: true, message: msg };
    } catch (e: any) {
        if (respondProfileRefusal(ctx, e)) return;
        // Thread and removed messages are refused outright (403) so the client can say why.
        respondToMessagingError(ctx, e, 'edit the message');
    }
});

/**
 * Delete for everyone (chat parity, 2026-09-23): the author takes their own message down, in a DM or a group
 * chat, at any age. The author is the verified signer — never a client-supplied field — so nobody can delete
 * someone else's. A convenor removing somebody ELSE's group chat message keeps its own route,
 * POST /api/groups/:id/chat/remove; the apps tell the two apart by `metadata.removedBy`.
 */
router.post('/api/messages/delete', async (ctx) => {
    const { messageId } = (ctx as any).requestBody || {};
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    if (!messageId || typeof messageId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'messageId is required' };
        return;
    }
    // Changing a group chat line is a write into a room that pushes to every member, exactly as posting one is,
    // so it is throttled exactly as posting one is: per signed member, in the chat bucket the two send routes
    // share (PR #1048 review). A DM keeps the DM rules — its fan-out is the other phone.
    if (isGroupChatMessage(messageId) && !chatRateLimit(ctx, actor)) return;
    try {
        ctx.body = { success: true, message: deleteOwnMessage(messageId, actor) };
    } catch (e: any) {
        respondToMessagingError(ctx, e, 'delete the message');
    }
});

router.get('/api/messages/conversations/:publicKey', async (ctx) => {
    const { publicKey } = ctx.params;
    // A2-3: this returns the subject's entire conversation graph + unread
    // counts + read cursors. Under read-auth, only the subject may read their
    // own — the verified signer must equal the :publicKey path param (which is
    // otherwise an unchecked IDOR: any member could read anyone's social graph).
    if (ENFORCE_READ_AUTH && ctx.state.actor !== publicKey) {
        ctx.status = 403;
        ctx.body = { error: 'You may only read your own conversations' };
        return;
    }
    // An event hidden by reports (G3) is not there for anyone but its author, and its chat is named after it.
    const convs = getConversationsByMember(publicKey).filter(c => c.type !== 'event_thread' || !eventChatHiddenFrom(c.id, publicKey));
    const unreadCounts = getUnreadCounts(publicKey);
    const mutes = getChatMutesFor(publicKey);
    ctx.body = {
        conversations: convs.map(c => ({ ...c, unreadCount: unreadCounts[c.id] || 0, mute: mutes.get(c.id) ?? null })),
        totalUnread: Object.values(unreadCounts).reduce((a, b) => a + b, 0),
    };
});

router.post('/api/messages/mark-read', async (ctx) => {
    const actor = ctx.state.actor as string | undefined;
    const { conversationId } = (ctx as any).requestBody || {};
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    if (!conversationId) {
        ctx.status = 400;
        ctx.body = { error: 'Missing conversationId' };
        return;
    }
    const conv = getConversation(conversationId);
    if (!conv) {
        ctx.status = 404;
        ctx.body = { error: 'Conversation not found' };
        return;
    }
    // A group chat's read cursor lives on the member's participant row, which follows the group. A keeper's lives
    // in thread_read_cursors, never on a participant row: that would let the generic send route write into the
    // enterprise thread (PR #924 review, B1). Only a current keeper has one to move.
    if (conv.type === GROUP_THREAD_TYPE) {
        if (refuseGroupChat(ctx, conversationId, actor, CONVERSATION_NOT_FOUND)) return;
        syncGroupThreadMembership(conversationId, actor);
    } else if (conv.type === 'enterprise_thread') {
        if (!isKeeperOfEnterprise(actor, conversationId)) {
            ctx.status = 403;
            ctx.body = { error: 'Only the keepers of this enterprise have a read marker on its thread' };
            return;
        }
        markKeeperThreadRead(conversationId, actor);
        ctx.body = { success: true };
        return;
    } else if (!conv.participants.includes(actor)) {
        ctx.status = 403;
        ctx.body = { error: 'You are not a participant in this conversation' };
        return;
    }
    markConversationRead(actor, conversationId);
    ctx.body = { success: true };
});

/**
 * Mute one chat for 8 hours, a week or always, or unmute it (groups decision 12). Only pushes are silenced;
 * an @mention still gets through. Anyone who can read the chat may mute it for themselves.
 */
router.post('/api/messages/mute', async (ctx) => {
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    const { conversationId, duration } = (ctx as any).requestBody || {};
    if (!conversationId || typeof conversationId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'conversationId is required' };
        return;
    }
    if (duration !== 'off' && !isChatMuteDuration(duration)) {
        ctx.status = 400;
        ctx.body = { error: "duration must be '8h', '1w', 'always' or 'off'" };
        return;
    }
    const conv = getConversation(conversationId);
    if (!conv) {
        ctx.status = 404;
        ctx.body = { error: 'Conversation not found' };
        return;
    }
    if (conv.type === GROUP_THREAD_TYPE && refuseGroupChat(ctx, conversationId, actor, CONVERSATION_NOT_FOUND)) return;
    if (conv.type !== GROUP_THREAD_TYPE && !canOpenChat(conv, actor)) {
        ctx.status = 403;
        ctx.body = { error: 'You are not in this conversation' };
        return;
    }
    if (duration === 'off') {
        clearChatMute(conversationId, actor);
        ctx.body = { success: true, mute: null };
        return;
    }
    ctx.body = { success: true, mute: setChatMute(conversationId, actor, duration) };
});

router.get('/api/messages/:conversationId', async (ctx) => {
    const { conversationId } = ctx.params;
    const conv = getConversation(conversationId);
    if (!conv) {
        ctx.status = 404;
        ctx.body = { error: 'Conversation not found' };
        return;
    }
    // A group's chat is its current active members, re-checked against the group rather than the participants
    // mirror, and private whether or not this node enforces read auth. A removed member, someone who left, a
    // pending request, an open invitation and an outsider are all refused; node admins get no exception.
    if (conv.type === GROUP_THREAD_TYPE) {
        if (refuseGroupChat(ctx, conversationId, ctx.state.actor as string | undefined, CONVERSATION_NOT_FOUND)) return;
    }
    // A2-2: only a participant may read a conversation's messages + metadata.
    // Under read-auth the signer is a verified member (ctx.state.actor); require
    // it to be in this conversation. Without this, any member could read any
    // thread by id (system messages are plaintext, and
    // participants/reactions/post-linkage/read-cursors leak for every thread).
    else if (ENFORCE_READ_AUTH && conv.type !== 'enterprise_thread' && !conv.participants.includes(ctx.state.actor as string)) {
        ctx.status = 403;
        ctx.body = { error: 'You are not a participant in this conversation' };
        return;
    }
    // An event chat is the host plus everyone Going, re-checked against the RSVP rather than the
    // participants mirror, and private whether or not this node enforces read auth
    // (docs/events-on-the-map.md §2.2). The private note is never part of this payload — the event chat
    // route serves it, to the same people.
    if (conv.type === 'event_thread') {
        let allowed = false;
        let gone = false;
        try {
            const eventRow = loadEventForThread(conversationId);
            // Hidden by reports (G3): not there for anyone but its author, as the event chat route answers.
            if (eventHiddenFrom(eventRow, ctx.state.actor as string | undefined)) {
                ctx.status = CONVERSATION_NOT_FOUND.status;
                ctx.body = { error: CONVERSATION_NOT_FOUND.error };
                return;
            }
            // The 30-day window is the chat's, not the event-chat route's: past it the event chat route
            // answers 410 and this one has to agree, or a host or a Going member could keep reading a
            // chat the scrub is about to take — and, between the window closing and the next scheduler
            // tick, read it here after being refused there. Checked BEFORE the membership check so the
            // answer does not depend on who is asking.
            gone = isEventThreadExpired(eventRow);
            allowed = !gone && canReadEventThread(eventRow, ctx.state.actor as string | undefined);
        } catch { allowed = false; }
        if (gone) {
            ctx.status = 410;
            ctx.body = { error: EVENT_CHAT_GONE };
            return;
        }
        if (!allowed) {
            ctx.status = 403;
            ctx.body = { error: 'Only the host and people going can open this event chat' };
            return;
        }
    }
    const limit = clampLimit(ctx.query.limit);
    const offset = clampOffset(ctx.query.offset);
    ctx.body = {
        conversation: conv,
        messages: getConversationMessages(conversationId, limit, offset),
    };
});

router.post('/api/messages/react', async (ctx) => {
    const { messageId, authorPubkey, emoji } = (ctx as any).requestBody || {};
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    if (!messageId || !emoji || typeof emoji !== 'string' || !emoji.trim() || emoji.length > 32) {
        ctx.status = 400;
        ctx.body = { error: 'messageId, authorPubkey, and a valid emoji (<=32 chars) are required' };
        return;
    }
    // Changing a group chat line is a write into a room that pushes to every member, exactly as posting one is,
    // so it is throttled exactly as posting one is: per signed member, in the chat bucket the two send routes
    // share (PR #1048 review). A DM keeps the DM rules — its fan-out is the other phone.
    if (isGroupChatMessage(messageId) && !chatRateLimit(ctx, actor)) return;
    try {
        // A reaction is up to 32 characters of anything, shown to everyone in the chat: a muted member (G3) adds none.
        assertNotMuted(actor);
        const result = toggleMessageReaction(messageId, actor, emoji.trim());
        if (!result) {
            ctx.status = 404;
            ctx.body = { error: 'Message not found' };
            return;
        }
        ctx.body = { success: true, metadata: result.metadata };
    } catch (e: any) {
        if (respondProfileRefusal(ctx, e)) return;
        respondToMessagingError(ctx, e, 'update the reaction');
    }
});


    return router;
}
