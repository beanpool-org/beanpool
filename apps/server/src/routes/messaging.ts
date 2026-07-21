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
import { getLocalConfig } from '../local-config.js';
import { getConnectorByPublicUrl } from '../connector-manager.js';
import { federatedRelayMessage } from '../federation-protocol.js';
import { getP2PNode } from '../p2p.js';
import type { RouteDeps } from './types.js';

export function createMessagingRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { clampLimit, clampOffset, enforceReadAuth: ENFORCE_READ_AUTH } = deps;

// ===================== MESSAGING API (PUBLIC) =====================

router.post('/api/messages/conversation', async (ctx) => {
    const { type, participants, createdBy, name, postId } = (ctx as any).requestBody || {};
    if (!type || !participants || !createdBy) {
        ctx.status = 400;
        ctx.body = { error: 'type, participants, and createdBy are required' };
        return;
    }
    if (type === 'dm' && participants.length !== 2) {
        ctx.status = 400;
        ctx.body = { error: 'DM conversations must have exactly 2 participants' };
        return;
    }
    // A2-15: the creator (bound to the verified signer by the spoof check) must
    // be one of the participants. Otherwise a member could fabricate a thread
    // between OTHER people (a DM "between B and C", or a group they aren't in)
    // and inject it into victims' inboxes with an arbitrary name. Enforced at
    // this public route only — internal/system conversation creation
    // (ensureTransactionConversation, injectSystemMessage) calls
    // createConversation directly with a system actor and is unaffected.
    if (!Array.isArray(participants) || !participants.includes(createdBy)) {
        ctx.status = 403;
        ctx.body = { error: 'Creator must be a participant of the conversation' };
        return;
    }
    const conv = createConversation(type, participants, createdBy, name, postId);
    if (!conv) {
        ctx.status = 400;
        ctx.body = { error: 'Failed to create conversation — check all participants are registered' };
        return;
    }
    ctx.body = { success: true, conversation: conv };
});

router.post('/api/messages/send', async (ctx) => {
    const { conversationId, authorPubkey, ciphertext, nonce, type, attachment, metadata, id } = (ctx as any).requestBody || {};
    if (!conversationId || !authorPubkey || !ciphertext || !nonce) {
        ctx.status = 400;
        ctx.body = { error: 'conversationId, authorPubkey, ciphertext, and nonce are required' };
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
        if (e?.code === 'ID_CONFLICT') {
            ctx.status = 409;
            ctx.body = { error: 'Message id already exists' };
            return;
        }
        throw e;
    }
    if (!msg) {
        ctx.status = 400;
        ctx.body = { error: 'Failed to send — conversation not found or not a participant' };
        return;
    }

    // --- FEDERATION RELAY ---
    try {
        const conv = getConversation(conversationId);
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
    const actor = ctx.state.actor || (ctx as any).requestBody?.authorPubkey;
    if (!messageId || !ciphertext || !nonce || !actor) {
        ctx.status = 400;
        ctx.body = { error: 'messageId, ciphertext, and nonce are required' };
        return;
    }
    try {
        const msg = editMessage(messageId, actor as string, ciphertext, nonce);
        ctx.body = { success: true, message: msg };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to edit message' };
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
    const convs = getConversationsByMember(publicKey);
    const unreadCounts = getUnreadCounts(publicKey);
    ctx.body = {
        conversations: convs.map(c => ({ ...c, unreadCount: unreadCounts[c.id] || 0 })),
        totalUnread: Object.values(unreadCounts).reduce((a, b) => a + b, 0),
    };
});

router.post('/api/messages/mark-read', async (ctx) => {
    const { pubkey, conversationId } = (ctx as any).requestBody || {};
    if (!pubkey || !conversationId) {
        ctx.status = 400;
        ctx.body = { error: 'Missing pubkey or conversationId' };
        return;
    }
    markConversationRead(pubkey, conversationId);
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
    // Under read-auth the signer is a verified member (ctx.state.actor); require
    // it to be in this conversation. Without this, any member could read any
    // thread by id (group/system messages are still plaintext-v1, and
    // participants/reactions/post-linkage/read-cursors leak for every thread).
    if (ENFORCE_READ_AUTH && !conv.participants.includes(ctx.state.actor as string)) {
        ctx.status = 403;
        ctx.body = { error: 'You are not a participant in this conversation' };
        return;
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
    if (!messageId || !authorPubkey || !emoji) {
        ctx.status = 400;
        ctx.body = { error: 'messageId, authorPubkey, and emoji are required' };
        return;
    }
    try {
        const result = toggleMessageReaction(messageId, authorPubkey, emoji);
        if (!result) {
            ctx.status = 404;
            ctx.body = { error: 'Message not found' };
            return;
        }
        ctx.body = { success: true, metadata: result.metadata };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to toggle reaction' };
    }
});


    return router;
}
