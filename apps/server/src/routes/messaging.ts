/**
 * Messaging routes — Conversations, DMs, Groups, Attachments, Reactions.
 */

import Router from '@koa/router';
import {
    createConversation, sendMessage, editMessage,
    getConversationsByMember, toggleMessageReaction,
    getConversationMessages, getConversation,
    markConversationRead, getUnreadCounts,
    getMember,
} from '../state-engine.js';
import { MessagingError } from '../engine/messaging.js';
import { canReadEventThread, loadEventForThread } from '../engine/event-thread.js';
import { getLocalConfig } from '../config/local-config.js';
import { getConnectorByPublicUrl } from '../connector-manager.js';
import { federatedRelayMessage } from '../federation-protocol.js';
import { getP2PNode } from '../p2p.js';
import type { RouteDeps } from './types.js';

export function createMessagingRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { clampLimit, clampOffset, enforceReadAuth: ENFORCE_READ_AUTH } = deps;

// ===================== MESSAGING API (PUBLIC) =====================

/** Upper bound on people in one group conversation. Each one is a synchronous INSERT
 *  inside the creation transaction, so this is what stops a single request holding the
 *  SQLite write lock against the whole node. */
const MAX_CONVERSATION_PARTICIPANTS = 50;

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
    const { type, participants, createdBy, name, postId } = (ctx as any).requestBody || {};
    if (!type || !participants || !createdBy) {
        ctx.status = 400;
        ctx.body = { error: 'type, participants, and createdBy are required' };
        return;
    }
    // The engine types `type` as 'dm' | 'group', but TypeScript is not present at
    // runtime and conversations.type has no CHECK constraint, so any other string
    // sailed past both length rules below and re-opened the very hole the group cap
    // closes: type "bulk" with 5,000 participants took the exclusive write lock for
    // 5,000 INSERTs. Whitelist first, then the caps mean something.
    if (type !== 'dm' && type !== 'group') {
        ctx.status = 400;
        ctx.body = { error: 'type must be either "dm" or "group"' };
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
    if (type === 'dm' && uniqueParticipants.length !== 2) {
        ctx.status = 400;
        ctx.body = { error: 'DM conversations must have exactly 2 distinct participants' };
        return;
    }
    if (type === 'group' && uniqueParticipants.length > MAX_CONVERSATION_PARTICIPANTS) {
        ctx.status = 400;
        ctx.body = { error: `Group conversations can have at most ${MAX_CONVERSATION_PARTICIPANTS} participants` };
        return;
    }
    // A2-15: the creator (bound to the verified signer by the spoof check) must
    // be one of the participants. Otherwise a member could fabricate a thread
    // between OTHER people (a DM "between B and C", or a group they aren't in)
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
        const conv = createConversation(type, uniqueParticipants, createdBy, name, postId);
        if (!conv) {
            ctx.status = 400;
            ctx.body = { error: 'Failed to create conversation — check all participants are registered' };
            return;
        }
        ctx.body = { success: true, conversation: conv };
    } catch (e: any) {
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
    let msg;
    try {
        msg = sendMessage(conversationId, authorPubkey, ciphertext, nonce, type === 'image' ? 'image' : 'text', attachment, metadata, clientId);
    } catch (e: any) {
        respondToMessagingError(ctx, e, 'send the message');
        return;
    }
    if (!msg) {
        ctx.status = 400;
        ctx.body = { error: 'Failed to send — conversation not found or not a participant' };
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
    try {
        const msg = editMessage(messageId, actor, ciphertext, nonce);
        ctx.body = { success: true, message: msg };
    } catch (e: any) {
        // Thread and removed messages are refused outright (403) so the client can say why.
        respondToMessagingError(ctx, e, 'edit the message');
    }
});

router.get('/api/messages/conversations/:publicKey', async (ctx) => {
    const { publicKey } = ctx.params;
    // A2-3: this returns the subject's entire conversation graph + unread
    // counts + read cursors. Only the subject may read their own — the verified
    // signer must equal the :publicKey path param.
    if (!ctx.state.actor || ctx.state.actor !== publicKey) {
        ctx.status = 403;
        ctx.body = { error: 'You may only read your own conversations' };
        return;
    }
    const convs = getConversationsByMember(publicKey);
    const unreadCounts = getUnreadCounts(publicKey);
    ctx.body = {
        conversations: convs.map(c => ({ ...c, unreadCount: unreadCounts[c.id] || 0 })),
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
    if (!conv.participants.includes(actor)) {
        ctx.status = 403;
        ctx.body = { error: 'You are not a participant in this conversation' };
        return;
    }
    markConversationRead(actor, conversationId);
    ctx.body = { success: true };
});

router.get('/api/messages/:conversationId', async (ctx) => {
    const { conversationId } = ctx.params;
    const conv = getConversation(conversationId);
    if (!conv) {
        ctx.status = 404;
        ctx.body = { error: 'Conversation not found' };
        return;
    }
    // A2-2: only a participant may read a conversation's messages + metadata.
    // Group/system messages are still plaintext-v1, and participants/reactions/
    // post-linkage/read-cursors leak for every thread if an outsider can read it.
    if (conv.type !== 'enterprise_thread' && conv.type !== 'event_thread' && (!ctx.state.actor || !conv.participants.includes(ctx.state.actor as string))) {
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
        try {
            allowed = canReadEventThread(loadEventForThread(conversationId), ctx.state.actor as string | undefined);
        } catch { allowed = false; }
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
    try {
        const result = toggleMessageReaction(messageId, actor, emoji.trim());
        if (!result) {
            ctx.status = 404;
            ctx.body = { error: 'Message not found' };
            return;
        }
        ctx.body = { success: true, metadata: result.metadata };
    } catch (e: any) {
        respondToMessagingError(ctx, e, 'update the reaction');
    }
});


    return router;
}
