import { describe, it, expect } from 'vitest';
import { inConversationTab, groupsUnreadCount, isMutedNow } from './conversation-tabs';

const NOW = new Date('2026-10-16T00:00:00Z');

describe('conversation-tabs: the Messages chips (Groups as the phone\'s Talk → Groups)', () => {
    it('each chat other than under All sits under one chip only', () => {
        const dm = { type: 'dm' as const };
        const trade = { type: 'dm' as const, postId: 'post-1' };
        const group = { type: 'group_thread' as const };
        const event = { type: 'event_thread' as const, postId: 'evt-1' };
        const enterprise = { type: 'enterprise_thread' as any };
        const where = (c: any) => (['transactions', 'direct', 'groups'] as const).filter(tab => inConversationTab(c, tab));
        expect(where(dm)).toEqual(['direct']);
        expect(where(trade)).toEqual(['transactions']);
        expect(where(group)).toEqual(['groups']);
        expect(where(event)).toEqual(['groups']);
        expect(where(enterprise)).toEqual(['groups']);
        for (const c of [dm, trade, group, event, enterprise]) expect(inConversationTab(c, 'all')).toBe(true);
    });

    it("the Groups count adds the group chats' unread lines, but not a muted chat's (the phone's rule) nor a DM's", () => {
        const convs = [
            { type: 'group_thread' as const, unreadCount: 2 },
            { type: 'event_thread' as const, unreadCount: 3 },
            { type: 'group_thread' as const, unreadCount: 4, mute: { mutedUntil: null, always: true } },
            { type: 'group_thread' as const, unreadCount: 5, mute: { mutedUntil: '2026-10-17T00:00:00Z', always: false } },
            { type: 'group_thread' as const, unreadCount: 7, mute: { mutedUntil: '2026-10-15T00:00:00Z', always: false } },
            { type: 'dm' as const, unreadCount: 11 },
        ];
        expect(groupsUnreadCount(convs, NOW)).toBe(2 + 3 + 7);
        expect(groupsUnreadCount([], NOW)).toBe(0);
    });

    it('a mute is on for good, or until a time still ahead', () => {
        expect(isMutedNow(null, NOW)).toBe(false);
        expect(isMutedNow({ mutedUntil: null, always: false }, NOW)).toBe(true);
        expect(isMutedNow({ mutedUntil: '2026-10-15T00:00:00Z', always: true }, NOW)).toBe(true);
        expect(isMutedNow({ mutedUntil: '2026-10-15T00:00:00Z', always: false }, NOW)).toBe(false);
        expect(isMutedNow({ mutedUntil: 'not a date', always: false }, NOW)).toBe(false);
    });
});
