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

/** The Groups chip's count: every unread line in the group-like chats, as the phone's Groups switch shows it. */
export function groupsUnreadCount(convs: ReadonlyArray<Pick<Conversation, 'type' | 'unreadCount'>>): number {
    return convs.reduce((sum, c) => sum + (isGroupLikeChat(c) ? Math.max(0, c.unreadCount || 0) : 0), 0);
}
