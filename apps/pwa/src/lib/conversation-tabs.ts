// The Messages list's filter chips: All, Transactions, Direct and Groups. Groups is the phone's Talk → Groups (groups
// decision 6): the group, enterprise and event chats. Each chat other than under All sits under one chip only.

import type { Conversation } from './api';

export type ConversationTab = 'all' | 'transactions' | 'direct' | 'groups';

/** A chat for some people rather than two: a Commons group's, an enterprise's or an event's. */
export function isGroupLikeChat(conv: Pick<Conversation, 'type'>): boolean {
    return conv.type !== 'dm';
}

/** Whether a conversation belongs under a chip. A group chat has no postId, so Direct asks for a DM by type. */
export function inConversationTab(conv: Pick<Conversation, 'type' | 'postId'>, tab: ConversationTab): boolean {
    if (tab === 'groups') return isGroupLikeChat(conv);
    if (tab === 'transactions') return !!conv.postId && !isGroupLikeChat(conv);
    if (tab === 'direct') return !conv.postId && !isGroupLikeChat(conv);
    return true;
}

/** A chat's mute as the node's conversation list gives it (engine/chat-mutes.ts ChatMute); null when not muted. */
export interface ConversationMute {
    mutedUntil: string | null;
    always: boolean;
}

/** Muted now: for good, or until a time still ahead (the phone's utils/your-groups.ts isMuted). */
export function isMutedNow(mute: ConversationMute | null | undefined, now: Date = new Date()): boolean {
    if (!mute) return false;
    if (mute.always || mute.mutedUntil === null) return true;
    const until = new Date(mute.mutedUntil).getTime();
    return !isNaN(until) && until > now.getTime();
}

/**
 * The Groups chip's count, the phone's Groups switch total (decision 12, WhatsApp's rule): every unread line in the
 * group-like chats, except in a chat muted (on the phone: the web has no mute of its own yet).
 */
export function groupsUnreadCount(
    convs: ReadonlyArray<Pick<Conversation, 'type' | 'unreadCount'> & { mute?: ConversationMute | null }>,
    now: Date = new Date(),
): number {
    return convs.reduce((sum, c) => sum + (isGroupLikeChat(c) && !isMutedNow(c.mute, now) ? Math.max(0, c.unreadCount || 0) : 0), 0);
}
