import { describe, it, expect } from 'vitest';
import {
    ownerHeader, previewLine, rowTime, unreadLabel, isMuted, groupsYouCouldJoin, inviteLandingAction, chatHref,
    threadMessageText, chatEmoji,
} from '../your-groups';

const g = (over: any) => ({
    id: 'g', name: 'G', slug: 'g', description: null, avatarUrl: null, category: 'social', createdBy: 'x',
    joinPolicy: 'open', createdAt: '', updatedAt: '', ...over,
});

describe('one chat header for every conversation (decision 9)', () => {
    it('names the owner and says what kind it is', () => {
        expect(ownerHeader('group', 'Garden Crew', 'social')).toMatchObject({ title: '🌻 Garden Crew', kindWord: 'group' });
        expect(ownerHeader('enterprise', 'Bakery')).toMatchObject({ title: '🥖 Bakery', kindWord: 'enterprise' });
        expect(ownerHeader('event', 'Working bee')).toMatchObject({ title: '📅 Working bee', kindWord: 'event' });
    });

    it('never shows an empty name, and an unknown category still gets an icon', () => {
        expect(ownerHeader('group', '  ').title).toBe('🌻 Group'.replace('🌻', chatEmoji('group', undefined)));
        expect(chatEmoji('group', 'nonsense')).toBe('👥');
    });
});

describe('row preview', () => {
    const msg = (over: any) => ({ id: 'm', authorPubkey: 'ana', authorCallsign: 'Ana', type: 'text', systemType: null, text: 'hi', timestamp: '', ...over });

    it('says who spoke, and "You" for me', () => {
        expect(previewLine({ kind: 'group', role: 'member', lastMessage: msg({}) }, 'me')).toBe('Ana: hi');
        expect(previewLine({ kind: 'group', role: 'member', lastMessage: msg({ authorPubkey: 'me' }) }, 'me')).toBe('You: hi');
    });

    it('shows a system line as written', () => {
        expect(previewLine({ kind: 'group', role: 'member', lastMessage: msg({ type: 'system', authorPubkey: 'SYSTEM', text: 'Ana joined' }) }, 'me')).toBe('Ana joined');
    });

    it('nudges the convenor of a new, empty group to invite people (decision 8)', () => {
        expect(previewLine({ kind: 'group', role: 'convenor', lastMessage: null })).toMatch(/invite people/);
        expect(previewLine({ kind: 'event', role: 'going', lastMessage: null })).toBe('No messages yet');
    });
});

describe('small labels', () => {
    it('caps the unread badge', () => {
        expect(unreadLabel(0)).toBe('');
        expect(unreadLabel(7)).toBe('7');
        expect(unreadLabel(120)).toBe('99+');
    });

    it('times: clock today, weekday this week, date before', () => {
        const now = new Date(2026, 8, 19, 15, 0);
        expect(rowTime(new Date(2026, 8, 19, 9, 5).toISOString(), now)).toBe('09:05');
        expect(rowTime(new Date(2026, 8, 17, 9, 5).toISOString(), now)).toBe('Thu');
        expect(rowTime(new Date(2026, 7, 2, 9, 5).toISOString(), now)).toBe('2 Aug');
        expect(rowTime('garbage', now)).toBe('');
    });

    it('mute: for good, until a future time, or lapsed', () => {
        const now = new Date('2026-09-19T00:00:00Z');
        expect(isMuted(null, now)).toBe(false);
        expect(isMuted({ conversationId: 'c', mutedUntil: null, always: true }, now)).toBe(true);
        expect(isMuted({ conversationId: 'c', mutedUntil: '2026-09-20T00:00:00Z', always: false }, now)).toBe(true);
        expect(isMuted({ conversationId: 'c', mutedUntil: '2026-09-18T00:00:00Z', always: false }, now)).toBe(false);
    });
});

describe('Commons → Groups you could join (decision 7)', () => {
    it('leaves out groups I am in, asked to join, or was removed from; keeps open invitations', () => {
        const all = [
            g({ id: 'mine' }), g({ id: 'active', viewerStatus: 'active' }), g({ id: 'asked', viewerStatus: 'pending_approval' }),
            g({ id: 'removed', viewerStatus: 'removed' }), g({ id: 'invited', viewerStatus: 'invited' }), g({ id: 'open' }),
        ] as any;
        expect(groupsYouCouldJoin(all, new Set(['mine'])).map(x => x.id)).toEqual(['invited', 'open']);
    });
});

describe('invite landing button', () => {
    it('follows standing first, then the join policy', () => {
        expect(inviteLandingAction({ joinPolicy: 'invite_only', viewerStatus: 'invited' })).toMatchObject({ label: 'Join the group', enabled: true });
        expect(inviteLandingAction({ joinPolicy: 'open', viewerStatus: null })).toMatchObject({ label: 'Join the group', enabled: true });
        expect(inviteLandingAction({ joinPolicy: 'request_to_join', viewerStatus: null })).toMatchObject({ label: 'Ask to join', enabled: true });
        expect(inviteLandingAction({ joinPolicy: 'invite_only', viewerStatus: null }).enabled).toBe(false);
        expect(inviteLandingAction({ joinPolicy: 'open', viewerStatus: 'pending_approval' }).enabled).toBe(false);
        expect(inviteLandingAction({ joinPolicy: 'open', viewerStatus: 'removed' }).enabled).toBe(false);
        expect(inviteLandingAction({ joinPolicy: 'open', viewerStatus: 'active' }).label).toBe('Open the group chat');
    });
});

describe('opening a chat', () => {
    it('tells the chat screen its kind, and marks a just-created group', () => {
        expect(chatHref({ kind: 'group', conversationId: 'g1', name: 'Crew' }, { created: true }))
            .toEqual({ pathname: '/chat/g1', params: { group: '1', name: 'Crew', created: '1' } });
        expect(chatHref({ kind: 'enterprise', conversationId: 'pk' }).params).toEqual({ enterprise: '1' });
        expect(chatHref({ kind: 'event', conversationId: 'e1' }, { created: true }).params).toEqual({ event: '1' });
    });

    it('decodes spoken messages but shows system lines as stored', () => {
        const decode = (c: string) => `decoded(${c})`;
        expect(threadMessageText({ type: 'text', authorPubkey: 'a', ciphertext: 'aGk=' }, decode)).toBe('decoded(aGk=)');
        expect(threadMessageText({ type: 'system', authorPubkey: 'SYSTEM', ciphertext: 'Ana joined' }, decode)).toBe('Ana joined');
    });
});
