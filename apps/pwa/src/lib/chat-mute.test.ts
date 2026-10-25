import { describe, it, expect } from 'vitest';
import {
    isMuted,
    muteMenuLabel,
    chatMuteFromAnswer,
    groupHeaderDetail,
    MUTE_CHOICES,
} from './chat-mute';

describe('chat-mute helpers', () => {
    it('isMuted identifies whether mute is active', () => {
        expect(isMuted(null)).toBe(false);
        expect(isMuted(undefined)).toBe(false);

        // Always muted
        expect(isMuted({ conversationId: 'c1', mutedUntil: null, always: true })).toBe(true);

        // Muted in future
        const future = new Date(Date.now() + 3600 * 1000).toISOString();
        expect(isMuted({ conversationId: 'c1', mutedUntil: future, always: false })).toBe(true);

        // Expired mute
        const past = new Date(Date.now() - 3600 * 1000).toISOString();
        expect(isMuted({ conversationId: 'c1', mutedUntil: past, always: false })).toBe(false);
    });

    it('muteMenuLabel returns "Unmute" when muted, "Mute notifications" when not', () => {
        expect(muteMenuLabel(null)).toBe('Mute notifications');
        expect(muteMenuLabel({ conversationId: 'c1', mutedUntil: null, always: true })).toBe('Unmute');
    });

    it('chatMuteFromAnswer extracts mute record from group chat answer', () => {
        expect(chatMuteFromAnswer(null)).toBeNull();
        expect(chatMuteFromAnswer({})).toBeNull();
        expect(chatMuteFromAnswer({ mute: null })).toBeNull();

        const mute = { conversationId: 'c1', mutedUntil: null, always: true };
        expect(chatMuteFromAnswer({ mute })).toEqual(mute);
    });

    it('groupHeaderDetail formats member count and muted suffix properly', () => {
        expect(groupHeaderDetail(1, false)).toBe('1 member');
        expect(groupHeaderDetail(2, false)).toBe('2 members');
        expect(groupHeaderDetail(1, true)).toBe('1 member · muted');
        expect(groupHeaderDetail(5, true)).toBe('5 members · muted');
        expect(groupHeaderDetail(null, true)).toBe('muted');
        expect(groupHeaderDetail(null, false)).toBeNull();
    });

    it('MUTE_CHOICES contains 8h, 1w, always with correct labels', () => {
        expect(MUTE_CHOICES).toHaveLength(3);
        expect(MUTE_CHOICES.map(c => c.key)).toEqual(['8h', '1w', 'always']);
    });
});
