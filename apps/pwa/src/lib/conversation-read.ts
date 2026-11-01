/**
 * Conversation read notification for the web app.
 *
 * When a conversation's unread lines are marked read on the server:
 * - App refreshes totalUnread so the sidebar's / bottom nav's Chat badge clears at once.
 * - Home store cache for the header is invalidated (forgetHomeForHeader).
 * - NeedsYouIcons refreshes its needs entries.
 * - Home page (if mounted) refreshes its unread / group cards.
 */

import { forgetHomeForHeader } from './home-store';

export const CONVERSATION_READ_EVENT = 'beanpool:conversation-read';

export function notifyConversationRead(conversationId?: string): void {
    forgetHomeForHeader();
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(CONVERSATION_READ_EVENT, { detail: { conversationId } }));
    }
}

export function onConversationRead(listener: (conversationId?: string) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const handler = (e: Event) => {
        const id = (e as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
        listener(id);
    };
    window.addEventListener(CONVERSATION_READ_EVENT, handler);
    return () => {
        window.removeEventListener(CONVERSATION_READ_EVENT, handler);
    };
}
