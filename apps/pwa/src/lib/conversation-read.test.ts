import { describe, it, expect, vi } from 'vitest';
import { CONVERSATION_READ_EVENT, notifyConversationRead, onConversationRead } from './conversation-read';
import { recordHomeAnswer, freshHomeForHeader } from './home-store';

describe('conversation-read event channel', () => {
    it('notifies listeners and clears home-store cache when a conversation is read', () => {
        recordHomeAnswer({
            me: null,
            generatedAt: '',
            profile: 'local',
            features: {},
            cards: { needs: { items: [{ kind: 'message', count: 1, accent: false, label: 'Unread', target: { to: 'unread-messages' } }] } },
        }, 'user-pk');
        expect(freshHomeForHeader('user-pk')).not.toBeNull();

        const heard: string[] = [];
        const unsub = onConversationRead((id) => {
            if (id) heard.push(id);
        });

        notifyConversationRead('conv-1');
        expect(heard).toEqual(['conv-1']);
        expect(freshHomeForHeader('user-pk')).toBeNull();

        unsub();
        notifyConversationRead('conv-2');
        expect(heard).toEqual(['conv-1']);
    });
});
