/**
 * Messaging routes — Conversations, DMs, Attachments, Reactions, mutes. A Commons group's chat is served by
 * routes/groups.ts; the reads and writes here re-check group membership for it.
 */

import crypto from 'node:crypto';
import Router from '@koa/router';
import {
    createConversation, sendMessage, editMessage, deleteOwnMessage,
    getConversationsByMember, toggleMessageReaction,
    getConversationMessages, getConversation,
    markConversationRead, getListedUnreadCounts, getUnreadCounts, getUnreadAnswer,
    getMember, isNodeMember, isLiveVisitor, getNodeRole, passesReadGate, weighRequestReports,
} from '../state-engine.js';
import { MessagingError, CHAT_GROUP_REMOVED_ERROR, DM_NAME_REFUSED_ERROR, isGroupChatMessage, assertMayOpenConversation, isVisitorsDirectLine } from '../engine/messaging.js';
import { canReadEventThread, withEventChatReaders, loadEventForThread, isEventThreadExpired, eventHiddenFrom, eventChatUnknownTo, chatHiddenFrom, waitingForHost, EVENT_CHAT_GONE, EVENT_CHAT_WAITING, EVENT_CHAT_WAITING_CODE } from '../engine/event-thread.js';
import { GROUP_THREAD_TYPE, groupChatRefusal, groupLineForReader, syncGroupThreadMembership } from '../engine/group-thread.js';
import { fromEpochOf } from '../engine/group-keys.js';
import { isKeeperOfEnterprise, markKeeperThreadRead, isEnterpriseThreadGone } from '../engine/enterprise-thread.js';
import { setChatMute, clearChatMute, getChatMutesFor, isChatMuteDuration } from '../engine/chat-mutes.js';
import { accountsDeletedAmong } from '../engine/message-tombstone.js';
import { withDmFormerKeys } from '../engine/key-succession.js';
import { getLocalConfig } from '../config/local-config.js';
import { getConnectorByPublicUrl } from '../connector-manager.js';
import { relayLineToPeer } from '../federation-protocol.js';
import { getP2PNode } from '../p2p.js';
import { chatRateLimit } from '../chat-rate-limit.js';
import { assertDmLineFits, assertMayReachNewPeople } from '../engine/writer-bounds.js';
import { assertNotMuted } from '../engine/auto-moderation.js';
import { assertMayMessage } from '../engine/probation.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import { membersOnlyHere } from './viewer.js';
import { READER_CACHE_CONTROL } from '../guest-cache.js';
import type { RouteDeps } from './types.js';
import { isNameableAccount, BAD_KEY_CODE, BAD_KEY_ERROR } from '../engine/member-key.js';
import {
    withheldConversationOwnedBy, withheldConversationById, withheldConversationView, withheldLine, pageWithOwnWithheld, listWithOwnWithheld, markWithheldConversationRead,
} from '../engine/withheld-lines.js';
import { withRequestFor, sortRequestsOut, decideRequest, ignoreAllRequests, RequestDecisionError } from '../engine/dm-requests.js';
import { NOT_A_MEMBER_CODE, NOT_A_MEMBER_ERROR } from '../engine/members.js';
import { checkDmLineReport, submitDmLineReport } from '../engine/dm-line-report.js';
import { GroupLineReportError } from '../engine/group-chat-report.js';
import { fileMessageReport } from './message-report.js';
import { word } from '@beanpool/core';

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

const CONVERSATION_NOT_FOUND = { status: 404, error: word('Conversation not found') };

/** Going to this event chat's event, and waiting for the host to let them in (engine/event-thread.ts waitingForHost). */
function eventWaitingFor(postId: string, actor: string | undefined): boolean {
    try { return waitingForHost(loadEventForThread(postId), actor); } catch { return false; }
}
const SEND_NOT_FOUND = { status: 400, error: word('Failed to send — conversation not found or not a participant') };

export function createMessagingRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { clampLimit, clampOffset } = deps;

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
        ctx.body = e.code ? { error: e.message, code: e.code, ...(e.extra ?? {}) } : { error: e.message };
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
    // One key, one spelling (engine/member-key.ts): a person is named by their key as this community keeps it. A key
    // in capitals was a second person here (a visitor's row made for it, or a second member row), whose messages the
    // member whose key it is never saw. Before anything is looked up for them or written.
    if (!participants.every((p: string) => isNameableAccount(p))) {
        ctx.status = 400;
        ctx.body = { error: BAD_KEY_ERROR, code: BAD_KEY_CODE };
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
    // A name on a DM was the phone's "decline with a message": the member's words, stored as the conversation's
    // name where the node could read them. They go as an encrypted message now (engine/messaging.ts).
    if (name !== undefined && name !== null && name !== '') {
        ctx.status = 400;
        ctx.body = { error: DM_NAME_REFUSED_ERROR };
        return;
    }
    try {
        // G3, global profile: a muted member starts no conversations (403); a new account starts them with at most
        // 10 new people a day (429). Starting one is a line in the other person's inbox, even before a message.
        assertNotMuted(createdBy);
        for (const other of uniqueParticipants) if (other !== createdBy) assertMayMessage(createdBy, other);
        // A visitor's row opens no new conversation, and so makes no row for anyone (assertMayOpenConversation).
        assertMayOpenConversation(createdBy, uniqueParticipants);
        // Every profile: a DM opened with someone who has no row here makes one for them, so at most 20 such people a
        // day (W-main, engine/writer-bounds.ts), after probation's stricter 10 new people where it is on. Checked by the
        // engine once the opener is known to be an active member, and before it writes anything: a limit never answers
        // for someone who may not open the conversation at all.
        const conv = createConversation('dm', uniqueParticipants, createdBy, name,
            () => assertMayReachNewPeople(createdBy, uniqueParticipants));
        if (!conv) {
            ctx.status = 400;
            ctx.body = { error: word('Failed to create conversation — check all participants are registered') };
            return;
        }
        // Where requests are on, whether it is a message request and whose (engine/dm-requests.ts), as the opener reads it.
        ctx.body = { success: true, conversation: withRequestFor(conv, createdBy) };
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
    // Every line through here is throttled per signed member, in the chat bucket: a DM line (W-main: it was limited
    // only by the gateway's 120 a minute, and each is a row a standby copies) and a group chat line, which is a row in
    // a room that pushes to every member, exactly as the group chat route throttles it (PR #924 review, item 4). An
    // invite-only group is 404 to an outsider here as there (item 5). Store apps up to 1.2.37 send group chat lines
    // through this route.
    if (!chatRateLimit(ctx, ctx.state.actor)) return;
    const target = getConversation(conversationId);
    if (target?.type === GROUP_THREAD_TYPE) {
        if (refuseGroupChat(ctx, conversationId, authorPubkey, SEND_NOT_FOUND)) return;
    }
    // An event's chat whose event isn't there for this caller (a group's event they can't see, or one hidden by reports)
    // is an id nobody has. The engine goes by the participants mirror, which keeps the seat of someone Going who has
    // since been removed from the group, and told them "Post to an event chat through the event" instead.
    if (target?.type === 'event_thread' && eventChatUnknownTo(conversationId, authorPubkey)) {
        ctx.status = SEND_NOT_FOUND.status;
        ctx.body = { error: SEND_NOT_FOUND.error };
        return;
    }
    let msg;
    try {
        // G3, global profile: a muted member sends nothing (403). A new account reaches at most 10 new people a
        // day in DMs (429); a reply, or anyone they have reached before (a conversation they opened included), is
        // never limited. An old conversation id the engine remaps is a DM between two people who have talked
        // already, so it is not checked here.
        assertNotMuted(authorPubkey);
        if (target?.type === 'dm' && target.participants.includes(authorPubkey)) {
            for (const other of target.participants) if (other !== authorPubkey) assertMayMessage(authorPubkey, other);
        }
        // A line's words at most 64 KB as stored (W-main); a photo goes as an attachment and is not counted. Checked by
        // the engine after every refusal of who may write in this conversation and just before the line is stored, so
        // a limit never answers for someone who may not write here (an enterprise or event chat's 403, an outsider's
        // 404). A group chat line is held to its own bound, GROUP_LINE_MAX_BYTES of sealed bytes (engine/group-thread.ts).
        msg = sendMessage(conversationId, authorPubkey, ciphertext, nonce, type === 'image' ? 'image' : 'text', attachment, metadata, clientId,
            (stored) => assertDmLineFits(stored.ciphertext, stored.metadata));
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
        // A line kept for its sender alone (engine/withheld-lines.ts) goes nowhere.
        const conv = withheldLine(msg.id) ? undefined : getConversation(msg.conversationId);
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

                            // Fire-and-forget over secure Libp2p mesh; a refusal or a failure is logged, never thrown here.
                            void relayLineToPeer(p2pNode, targetConnector.peerId, targetConnector.callsign || null, {
                                // The line's id, carried verbatim: the line is sealed to it (relayedMessageId).
                                id: msg.id,
                                senderPublicKey: authorPubkey,
                                senderCallsign: localMember?.callsign,
                                senderNodeUrl: localUrl,
                                recipientPublicKey: otherPubkey,
                                ciphertext,
                                nonce,
                                metadata
                            });
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
    const { messageId, ciphertext, nonce, metadata } = (ctx as any).requestBody || {};
    // The author is the verified request signer (ctx.state.actor) — not a client-supplied
    // field — so nobody can edit someone else's message.
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: word('A signed request is required') };
        return;
    }
    // The answer is the message with its reactions, each naming who reacted (as are delete's and react's). The chat
    // tests read participants and group rows, which a pruned account keeps: on a node that shows guests the listings
    // and not the people, for members of this node only, and a visitor's row in a DM it is in (isVisitorsDirectLine),
    // where it reads the same message and reactions already.
    if (!isVisitorsDirectLine(messageId, actor) && !membersOnlyHere(ctx)) return;
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
        // The same 64 KB as a new line (W-main), or an edit could grow a short line past it. Checked by the engine once
        // this caller may edit this message at all (never a thread's or an event chat's line, only their own, within the
        // 15 minutes), so the limit never answers in place of those refusals.
        const msg = editMessage(messageId, actor, ciphertext, nonce, () => assertDmLineFits(ciphertext), metadata);
        ctx.body = { success: true, message: msg };
    } catch (e: any) {
        if (respondProfileRefusal(ctx, e)) return;
        // Thread and removed messages are refused outright (403) so the client can say why.
        respondToMessagingError(ctx, e, 'edit the message');
    }
});

/**
 * Report one line of a direct message (engine/dm-line-report.ts): { messageId, reason, disclosure }, what the reporter's app
 * hands over for it. The reporter is the signer, never the body, and a member here, as for /api/reports. Any line that isn't
 * theirs to report answers as an id nobody has. The node opens nothing: it holds no key for the line. One report per
 * reporter per line (routes/message-report.ts).
 */
router.post('/api/messages/report', async (ctx) => {
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: word('A signed request is required') };
        return;
    }
    if (!membersOnlyHere(ctx)) return;
    let checked;
    try {
        checked = checkDmLineReport(actor, (ctx as any).requestBody || {});
    } catch (e) {
        if (!(e instanceof GroupLineReportError)) throw e;
        ctx.status = e.status;
        ctx.body = { error: e.message, code: e.code };
        return;
    }
    fileMessageReport(ctx, actor, checked.messageId, checked.reason, () => {
        const filed = submitDmLineReport(actor, checked);
        // One on a request they received counts towards clearing its sender's requests (engine/request-limits.ts).
        if (filed) weighRequestReports(checked.authorPubkey);
        return filed;
    });
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
        ctx.body = { error: word('A signed request is required') };
        return;
    }
    if (!isVisitorsDirectLine(messageId, actor) && !membersOnlyHere(ctx)) return; // the message and who reacted to it, as edit's answer
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

// How much waits for the signer here, in counts alone (never a key, a name, an id or a list): a phone asks each community it
// keeps but isn't using, every few minutes (scratch/fable-design/DESIGN-cross-community-chat-fable.md §1.2 R3), and the web
// app reads it for its own badge. It takes no key, so it can answer for the signer and nobody else. The read gate refuses
// the rest; the checks here hold where the gate lets a request through (read auth opted out), as /api/notices does: a
// visitor's row has no chats to come back to here, and a suspended member reads their own. No cached copy: a phone's
// answer is the only thing telling it a message is waiting.
router.get('/api/me/unread', async (ctx) => {
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: word('A signed request is required') };
        return;
    }
    if (!passesReadGate(actor)) {
        ctx.status = 403;
        ctx.body = { error: word('Read access requires a member identity'), code: NOT_A_MEMBER_CODE };
        return;
    }
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = getUnreadAnswer(actor);
});

router.get('/api/messages/conversations/:publicKey', async (ctx) => {
    const { publicKey } = ctx.params;
    // A2-3: this returns the subject's entire conversation graph + unread
    // counts + read cursors. Only the subject may read their own — the verified
    // signer must equal the :publicKey path param (which is otherwise an
    // unchecked IDOR: any member could read anyone's social graph) — whatever
    // ENFORCE_READ_AUTH says, as /api/community/me is: with read auth opted out
    // anyone, unsigned too, read who a member talks with and every chat's id.
    if (!ctx.state.actor) {
        ctx.status = 401;
        ctx.body = { error: word('A signed request is required') };
        return;
    }
    if (ctx.state.actor !== publicKey) {
        ctx.status = 403;
        ctx.body = { error: word('You may only read your own conversations') };
        return;
    }
    // An event hidden by reports (G3) is not there for anyone but its author, nor a group's event for someone no longer in
    // the group, and its chat is named after it (chatHiddenFrom). The unread counts leave out the same chats, as the
    // badge every push carries does (getListedUnreadCounts).
    // The member's own withheld conversations and lines (engine/withheld-lines.ts) are in their own list, read signed
    // by them, ordered as if nothing had been withheld; nobody else's list ever names one.
    const viewer: string = publicKey; // the verified signer, held above
    const convs = listWithOwnWithheld(viewer, getConversationsByMember(publicKey).filter(c => !chatHiddenFrom(c, publicKey)));
    // Where requests are on (engine/dm-requests.ts): each direct conversation says whether it is a message request, the
    // ones waiting for the viewer are listed apart in `requests`, and one they ignored, or from someone they blocked, in
    // neither. Their unread lines are in neither the list's count nor the badge (getListedUnreadCounts). Where requests are
    // off, the list as it always was, less one the viewer ignored while they were on.
    const sorted = sortRequestsOut(viewer, convs);
    const unreadCounts = getListedUnreadCounts(publicKey);
    const mutes = getChatMutesFor(publicKey);
    // A DM's re-keyed people's signed former keys, to someone in it (engine/key-succession.ts withDmFormerKeys).
    const shaped = <C extends { id: string }>(list: C[], counts: Record<string, number>) =>
        withDmFormerKeys(list.map(c => ({ ...withEventChatReaders(c as any), unreadCount: counts[c.id] || 0, mute: mutes.get(c.id) ?? null })), viewer);
    const conversations = shaped(sorted.listed, unreadCounts);
    const requests = sorted.requests && sorted.requests.length > 0 ? shaped(sorted.requests, getUnreadCounts(publicKey)) : [];
    // The people in these chats who deleted their accounts, every line of whose is now blanked: the phone blanks the older
    // lines of theirs it holds, which its sync (the newest 50 of each chat) never brings again (accountsDeletedAmong).
    // Only people already listed above as in the caller's chats.
    const others = new Set<string>();
    for (const c of [...conversations, ...requests]) for (const p of c.participants) if (p !== publicKey) others.add(p);
    // Over the listed chats only, as listYourChats does: a badge for a chat that isn't there can't be cleared.
    const body = {
        conversations,
        totalUnread: conversations.reduce((n, c) => n + c.unreadCount, 0),
        deletedAccounts: accountsDeletedAmong(others),
        ...(sorted.requests ? { requests: { count: sorted.count, conversations: requests } } : {}),
    };
    // The phone's message backstop reads this list every 120 s and the web app on every change (slice L0): a tag of the
    // reader and the answer itself, so a list that hasn't changed is a 304 and not the whole list again. Made of the
    // answer, never a counter, so no change it shows (a line, a read, a mute, a request) can be missed. The signer's own.
    // The JSON is made once, tagged and sent as it is (review of #2558, test-api-compression §7).
    const json = JSON.stringify(body);
    const etag = `W/"convs-${crypto.createHash('sha256').update(`${viewer}\n${json}`).digest('hex').slice(0, 24)}"`;
    ctx.set('ETag', etag);
    ctx.set('Cache-Control', READER_CACHE_CONTROL);
    const inm = typeof ctx.get === 'function' ? ctx.get('If-None-Match') : ctx.headers?.['if-none-match'];
    if (inm && inm.split(',').some((t: string) => t.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))) {
        ctx.status = 304;
        return;
    }
    ctx.type = 'application/json';
    ctx.body = json;
});

/**
 * A message request (engine/dm-requests.ts) is decided by the person it was sent to, signed by them, a member here or a
 * visitor's row (isLiveVisitor: a key a member messaged, or a member of another community reached over the relay, which
 * may decide one sent to it and nothing else new; the director's option b on PR #2392 review 4355750376, and the visitor
 * gate names these two routes, visitor-allowlist.ts), on the main server: a standby answers 503 `standby` and writes
 * nothing, as a block's change does (routes/blocks.ts). The actor, or undefined once the refusal is written.
 */
function requestDecider(ctx: any): string | undefined {
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: word('A signed request is required') };
        return undefined;
    }
    if (!isNodeMember(actor) && !isLiveVisitor(actor)) {
        ctx.status = 403;
        ctx.body = { error: NOT_A_MEMBER_ERROR, code: NOT_A_MEMBER_CODE };
        return undefined;
    }
    if (getNodeRole() !== 'primary') {
        ctx.status = 503;
        ctx.body = { error: word('This server is a standby copy of the community, not its main server. Message requests are answered on the main server.'), code: 'standby' };
        return undefined;
    }
    return actor;
}

/**
 * Accept or ignore a message request: `{ conversationId, decision: 'accept' | 'ignore' }`, by the person it was sent to
 * (engine/dm-requests.ts decideRequest). Answers `{ success, request }`, the request as they now read it. Accepting rings
 * both people's sockets (`dm_request_updated`), but not the opener's if they have blocked the person accepting; ignoring
 * only the ignorer's, and its opener is never told.
 */
router.post('/api/messages/request', async (ctx) => {
    const actor = requestDecider(ctx);
    if (!actor) return;
    const { conversationId, decision } = (ctx as any).requestBody || {};
    if (typeof conversationId !== 'string' || !conversationId || (decision !== 'accept' && decision !== 'ignore' && decision !== 'cancel')) {
        ctx.status = 400;
        ctx.body = { error: word("Send conversationId, the chat, and decision, 'accept', 'ignore' or 'cancel'.") };
        return;
    }
    try {
        ctx.body = { success: true, request: decideRequest(conversationId, actor, decision) };
    } catch (e) {
        if (e instanceof RequestDecisionError) {
            ctx.status = e.status;
            ctx.body = { error: e.message, code: e.code };
            return;
        }
        if (respondProfileRefusal(ctx, e)) return;
        respondToMessagingError(ctx, e, 'answer the message request');
    }
});

/** Ignore all: every message request waiting for the signer, at once (engine/dm-requests.ts). `{ success, ignored }`. */
router.post('/api/messages/request/ignore-all', async (ctx) => {
    const actor = requestDecider(ctx);
    if (!actor) return;
    try {
        ctx.body = { success: true, ignored: ignoreAllRequests(actor) };
    } catch (e) {
        if (respondProfileRefusal(ctx, e)) return;
        respondToMessagingError(ctx, e, 'ignore the message requests');
    }
});

router.post('/api/messages/mark-read', async (ctx) => {
    const actor = ctx.state.actor as string | undefined;
    const { conversationId } = (ctx as any).requestBody || {};
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: word('A signed request is required') };
        return;
    }
    if (!conversationId) {
        ctx.status = 400;
        ctx.body = { error: 'Missing conversationId' };
        return;
    }
    const conv = getConversation(conversationId);
    if (!conv) {
        // A conversation kept for its opener alone (engine/withheld-lines.ts) is read as any other: their read marker moves.
        if (withheldConversationOwnedBy(conversationId, actor)) {
            markWithheldConversationRead(conversationId, actor);
            ctx.body = { success: true };
            return;
        }
        // Someone else's: refused as a non-participant of a real conversation is (#1403 re-review).
        if (withheldConversationById(conversationId)) {
            ctx.status = 403;
            ctx.body = { error: word('You are not a participant in this conversation') };
            return;
        }
        ctx.status = 404;
        ctx.body = { error: word('Conversation not found') };
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
            ctx.body = { error: word('Only the keepers of this enterprise have a read marker on its thread') };
            return;
        }
        // On a standby, 409 `standby`: the read marks are the main server's (a plain table, design G4).
        try {
            markKeeperThreadRead(conversationId, actor);
        } catch (e) {
            if (respondProfileRefusal(ctx, e)) return;
            throw e;
        }
        ctx.body = { success: true };
        return;
    } else if (conv.type === 'event_thread' && eventChatUnknownTo(conversationId, actor)) {
        // A group's event the caller can't see (or one hidden by reports): an id nobody has, not "not a participant".
        ctx.status = CONVERSATION_NOT_FOUND.status;
        ctx.body = { error: CONVERSATION_NOT_FOUND.error };
        return;
    } else if (!conv.participants.includes(actor)) {
        ctx.status = 403;
        ctx.body = { error: word('You are not a participant in this conversation') };
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
        ctx.body = { error: word('A signed request is required') };
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
        // A conversation kept for its opener alone (engine/withheld-lines.ts) is muted as any other, the mute kept under
        // its id: the id it keeps when it becomes the real one.
        if (withheldConversationOwnedBy(conversationId, actor)) {
            ctx.body = duration === 'off'
                ? (clearChatMute(conversationId, actor), { success: true, mute: null })
                : { success: true, mute: setChatMute(conversationId, actor, duration) };
            return;
        }
        // Someone else's: refused as a non-participant of a real conversation is (#1403 re-review).
        if (withheldConversationById(conversationId)) {
            ctx.status = 403;
            ctx.body = { error: word('You are not in this conversation') };
            return;
        }
        ctx.status = 404;
        ctx.body = { error: word('Conversation not found') };
        return;
    }
    if (conv.type === GROUP_THREAD_TYPE && refuseGroupChat(ctx, conversationId, actor, CONVERSATION_NOT_FOUND)) return;
    if (conv.type === 'event_thread' && eventChatUnknownTo(conversationId, actor)) {
        ctx.status = CONVERSATION_NOT_FOUND.status;
        ctx.body = { error: CONVERSATION_NOT_FOUND.error };
        return;
    }
    if (conv.type !== GROUP_THREAD_TYPE && !canOpenChat(conv, actor)) {
        ctx.status = 403;
        ctx.body = { error: word('You are not in this conversation') };
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
    const viewer = ctx.state.actor as string | undefined;
    if (!conv) {
        // A conversation kept for its opener alone (engine/withheld-lines.ts): theirs, read signed by them, as any DM.
        const kept = withheldConversationOwnedBy(conversationId, viewer);
        if (kept) {
            ctx.body = {
                conversation: withRequestFor(withDmFormerKeys([withheldConversationView(kept)], viewer)[0], viewer),
                messages: pageWithOwnWithheld(conversationId, viewer, clampLimit(ctx.query.limit), clampOffset(ctx.query.offset), () => []),
            };
            return;
        }
        // Someone else's: answered as a real DM answers someone who isn't in it (#1403 re-review): refused
        // for non-participants.
        const other = withheldConversationById(conversationId);
        if (other) {
            ctx.status = 403;
            ctx.body = { error: word('You are not a participant in this conversation') };
            return;
        }
        ctx.status = 404;
        ctx.body = { error: word('Conversation not found') };
        return;
    }
    // A group's chat is its current active members, re-checked against the group rather than the participants
    // mirror, and private whether or not this node enforces read auth. A removed member, someone who left, a
    // pending request, an open invitation and an outsider are all refused; node admins get no exception.
    if (conv.type === GROUP_THREAD_TYPE) {
        if (refuseGroupChat(ctx, conversationId, ctx.state.actor as string | undefined, CONVERSATION_NOT_FOUND)) return;
    }
    // An event's chat whose event isn't there for this caller (a group's event they can't see, or one hidden by
    // reports) is an id nobody has, before the participant check below could say "not a participant".
    else if (conv.type === 'event_thread' && eventChatUnknownTo(conversationId, ctx.state.actor as string | undefined)) {
        ctx.status = CONVERSATION_NOT_FOUND.status;
        ctx.body = { error: CONVERSATION_NOT_FOUND.error };
        return;
    }
    // An enterprise's discussion reads like its own route's: gone with a pruned or deleted enterprise, for everyone.
    else if (conv.type === 'enterprise_thread' && isEnterpriseThreadGone(conversationId)) {
        ctx.status = CONVERSATION_NOT_FOUND.status;
        ctx.body = { error: CONVERSATION_NOT_FOUND.error };
        return;
    }
    // A2-2: only a participant may read a conversation's messages + metadata.
    // Require the signer (ctx.state.actor) to be in this conversation, whatever
    // ENFORCE_READ_AUTH says (#2119): with read auth opted out, anyone, unsigned
    // too, read any DM by id before.
    else if (conv.type !== 'enterprise_thread' && (!ctx.state.actor || !conv.participants.includes(ctx.state.actor))) {
        ctx.status = 403;
        // Going to an event whose host hasn't let them in yet (no seat until they do): the event chat route's words and code.
        ctx.body = conv.type === 'event_thread' && eventWaitingFor(conversationId, ctx.state.actor as string | undefined)
            ? { error: EVENT_CHAT_WAITING, code: EVENT_CHAT_WAITING_CODE }
            : { error: word('You are not a participant in this conversation') };
        return;
    }
    // An event chat is the host plus everyone Going, re-checked against the RSVP rather than the
    // participants mirror, and private whether or not this node enforces read auth
    // (docs/events-on-the-map.md §2.2). The private note is never part of this payload — the event chat
    // route serves it, to the same people.
    if (conv.type === 'event_thread') {
        let allowed = false;
        let gone = false;
        let waiting = false;
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
            // Going, and the host hasn't let them in: the event chat route's own words and code (the #1953 review's N5).
            waiting = !allowed && !gone && waitingForHost(eventRow, ctx.state.actor as string | undefined);
        } catch { allowed = false; }
        if (gone) {
            ctx.status = 410;
            ctx.body = { error: EVENT_CHAT_GONE };
            return;
        }
        if (!allowed) {
            ctx.status = 403;
            ctx.body = waiting
                ? { error: EVENT_CHAT_WAITING, code: EVENT_CHAT_WAITING_CODE }
                : { error: word('Only the host and people going can open this event chat') };
            return;
        }
    }
    const limit = clampLimit(ctx.query.limit);
    const offset = clampOffset(ctx.query.offset);
    // A group's chat leaves out the lines sealed under an epoch from before the reader's membership (group chat encryption
    // design §3), as GET /api/groups/:id/chat does. Filtered after the page is read, so offsets stay the same rows.
    const fromEpoch = conv.type === GROUP_THREAD_TYPE ? fromEpochOf(conversationId, viewer) : null;
    const page = (l: number, o: number) => conv.type === GROUP_THREAD_TYPE
        ? getConversationMessages(conversationId, l, o).filter((m: any) => groupLineForReader(m.metadata, fromEpoch))
        : getConversationMessages(conversationId, l, o);
    ctx.body = {
        // As the list serves it: a DM's re-keyed people's former keys, to someone in it (withDmFormerKeys), and whether it
        // is a message request, with the other's read marker left out until it is accepted (engine/dm-requests.ts).
        conversation: withRequestFor(withDmFormerKeys([withEventChatReaders(conv)], viewer)[0], viewer),
        // A DM's lines with the signed reader's own withheld ones among them (engine/withheld-lines.ts): what they sent,
        // as they sent it. Only the reader's own, so the other person's read is the lines and nothing else.
        messages: conv.type === 'dm' && viewer && conv.participants.includes(viewer)
            ? pageWithOwnWithheld(conversationId, viewer, limit, offset, page)
            : page(limit, offset),
    };
});

router.post('/api/messages/react', async (ctx) => {
    const { messageId, authorPubkey, emoji } = (ctx as any).requestBody || {};
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: word('A signed request is required') };
        return;
    }
    if (!isVisitorsDirectLine(messageId, actor) && !membersOnlyHere(ctx)) return; // who reacted, by key, as edit's answer
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
            ctx.body = { error: word('Message not found') };
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
