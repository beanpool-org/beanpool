import { describe, it, expect } from 'vitest';
import {
    ownerHeader, previewLine, rowTime, unreadLabel, isMuted, groupsYouCouldJoin, inviteLandingAction, chatHref,
    threadMessageText, chatEmoji, groupsUnreadTotal, rowBadge, yourGroupsPaneState, markChatRead, showInvitePrompt,
    inviteLandingPhase, inviteLandingFacts, inviteLandingHref, inviteLandingPreviewFromParams,
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

const chat = (over: any) => ({
    kind: 'group', badge: null, id: 'g', conversationId: 'g', name: 'G', avatarUrl: null, role: 'member', readOnly: false,
    lastMessage: null, unreadCount: 0, mute: null, lastActivityAt: '', ...over,
});
const NOW = new Date('2026-09-19T00:00:00Z');
const MUTED_FOR_GOOD = { conversationId: 'x', mutedUntil: null, always: true };
const MUTE_LAPSED = { conversationId: 'x', mutedUntil: '2026-09-18T00:00:00Z', always: false };

describe('the header label for every kind of chat (decision 9)', () => {
    it('reads "group", "enterprise" and "event", with the owner first and a spoken label for screen readers', () => {
        expect(ownerHeader('group', 'Garden Crew', 'guild')).toEqual({
            title: '🛡️ Garden Crew', kindWord: 'group', a11y: 'Garden Crew, group. Opens the group page.',
        });
        expect(ownerHeader('enterprise', 'Bakery')).toEqual({
            title: '🥖 Bakery', kindWord: 'enterprise', a11y: 'Bakery, enterprise. Opens the enterprise page.',
        });
        expect(ownerHeader('event', 'Working bee', 'social')).toEqual({
            title: '📅 Working bee', kindWord: 'event', a11y: 'Working bee, event. Opens the event page.',
        });
        expect(ownerHeader('event', '').title).toBe('📅 Event');
        expect(ownerHeader('enterprise', '').title).toBe('🥖 Enterprise');
    });
});

describe('your groups list: states and badges', () => {
    it('loading until the first answer, error only with nothing to show, then list or empty', () => {
        expect(yourGroupsPaneState(null, null)).toBe('loading');
        expect(yourGroupsPaneState(null, 'Could not reach the node.')).toBe('error');
        expect(yourGroupsPaneState([], null)).toBe('empty');
        expect(yourGroupsPaneState([chat({})], null)).toBe('list');
        // A refresh that fails later keeps the list on screen.
        expect(yourGroupsPaneState([chat({})], 'Could not reach the node.')).toBe('list');
        expect(yourGroupsPaneState([], 'Could not reach the node.')).toBe('empty');
    });

    it('badges only on Talk, grey when muted, nothing for zero, capped at 99+', () => {
        expect(rowBadge(chat({ unreadCount: 3 }), true, NOW)).toEqual({ label: '3', muted: false });
        expect(rowBadge(chat({ unreadCount: 3 }), false, NOW)).toBeNull();
        expect(rowBadge(chat({ unreadCount: 0 }), true, NOW)).toBeNull();
        expect(rowBadge(chat({ unreadCount: 3, mute: MUTED_FOR_GOOD }), true, NOW)).toEqual({ label: '3', muted: true });
        expect(rowBadge(chat({ unreadCount: 250 }), true, NOW)).toEqual({ label: '99+', muted: false });
    });
});

describe('the Groups unread total (decision 12)', () => {
    it('leaves muted chats out, counts lapsed mutes, and counts groups, enterprises and events alike', () => {
        const items = [
            chat({ unreadCount: 2 }),
            chat({ kind: 'enterprise', unreadCount: 1 }),
            chat({ kind: 'event', unreadCount: 4 }),
            chat({ unreadCount: 10, mute: MUTED_FOR_GOOD }),
            chat({ unreadCount: 5, mute: { conversationId: 'x', mutedUntil: '2026-09-20T00:00:00Z', always: false } }),
            chat({ unreadCount: 3, mute: MUTE_LAPSED }),
        ];
        expect(groupsUnreadTotal(items as any, NOW)).toBe(2 + 1 + 4 + 3);
    });

    it('is zero for nothing, and never goes negative on a bad count', () => {
        expect(groupsUnreadTotal(null, NOW)).toBe(0);
        expect(groupsUnreadTotal([chat({ unreadCount: -3 })] as any, NOW)).toBe(0);
    });
});

describe('opening a chat marks it read', () => {
    it('clears that chat only, and hands back the same list when there was nothing to clear', () => {
        const items = [chat({ conversationId: 'a', unreadCount: 3 }), chat({ conversationId: 'b', unreadCount: 2 })];
        const after = markChatRead(items as any, 'a');
        expect(after.map(i => i.unreadCount)).toEqual([0, 2]);
        expect(items[0].unreadCount).toBe(3);
        expect(markChatRead(after, 'a')).toBe(after);
        expect(markChatRead(after, 'nope')).toBe(after);
    });
});

describe('after Create a Group: land in the chat, invite prompt skippable (decision 8)', () => {
    const base = { kind: 'group' as const, isConvenor: true, justCreated: true, activeCount: 1, invitedCount: 0, spokenCount: 0, skipped: false };

    it('lands in the new group\'s chat, told it was just created', () => {
        expect(chatHref({ kind: 'group', conversationId: 'g9', name: 'Choir' }, { created: true }))
            .toEqual({ pathname: '/chat/g9', params: { group: '1', name: 'Choir', created: '1' } });
    });

    it('asks who to invite in a brand-new group', () => {
        expect(showInvitePrompt(base)).toBe(true);
    });

    it('"Not now" skips it', () => {
        expect(showInvitePrompt({ ...base, skipped: true })).toBe(false);
    });

    it('steps aside once someone is invited or something is said', () => {
        expect(showInvitePrompt({ ...base, invitedCount: 1 })).toBe(false);
        expect(showInvitePrompt({ ...base, spokenCount: 1 })).toBe(false);
    });

    it('comes back for a convenor still alone on a later visit, never for a member or an enterprise', () => {
        expect(showInvitePrompt({ ...base, justCreated: false })).toBe(true);
        expect(showInvitePrompt({ ...base, justCreated: false, activeCount: 3 })).toBe(false);
        expect(showInvitePrompt({ ...base, justCreated: false, isConvenor: false })).toBe(false);
        expect(showInvitePrompt({ ...base, kind: 'enterprise' })).toBe(false);
    });
});

describe('invite landing states', () => {
    it('draws the outline (skeleton) before the node answers, and an error only when it could not be reached', () => {
        expect(inviteLandingPhase({ group: undefined, error: null, openedAsInvite: true })).toBe('skeleton');
        expect(inviteLandingPhase({ group: undefined, error: 'Network request failed', openedAsInvite: true })).toBe('error');
    });

    it('loaded: an open invitation, or any group anyone may join or ask to join', () => {
        expect(inviteLandingPhase({ group: { joinPolicy: 'invite_only', viewerStatus: 'invited' }, error: null, openedAsInvite: true })).toBe('ready');
        expect(inviteLandingPhase({ group: { joinPolicy: 'open', viewerStatus: null }, error: null, openedAsInvite: true })).toBe('ready');
        expect(inviteLandingPhase({ group: { joinPolicy: 'request_to_join', viewerStatus: null }, error: null, openedAsInvite: true })).toBe('ready');
        expect(inviteLandingPhase({ group: { joinPolicy: 'invite_only', viewerStatus: 'active' }, error: null, openedAsInvite: true })).toBe('ready');
    });

    it('expired: opened as an invitation that is gone, with no other way in', () => {
        expect(inviteLandingPhase({ group: { joinPolicy: 'invite_only', viewerStatus: null }, error: null, openedAsInvite: true })).toBe('expired');
        expect(inviteLandingPhase({ group: null, error: null, openedAsInvite: true })).toBe('expired');
    });

    it('unavailable: not found, when nobody said it was an invitation', () => {
        expect(inviteLandingPhase({ group: null, error: null, openedAsInvite: false })).toBe('unavailable');
    });

    it('the tap carries what it knew, so the skeleton already has the name and facts', () => {
        const href = inviteLandingHref({ id: 'g1', name: 'Garden Crew', category: 'social', joinPolicy: 'invite_only', memberCount: 4, viewerStatus: 'invited' });
        expect(href).toEqual({
            pathname: '/group/g1',
            params: { name: 'Garden Crew', category: 'social', joinPolicy: 'invite_only', memberCount: '4', invited: '1' },
        });
        const preview = inviteLandingPreviewFromParams(href.params);
        expect(preview).toEqual({ name: 'Garden Crew', category: 'social', joinPolicy: 'invite_only', memberCount: 4, invited: true });
        expect(inviteLandingFacts(preview)).toBe('Social Circle · 4 members · Invite only');
    });

    it('a bare link (no preview) still parses, and bad numbers are left out', () => {
        expect(inviteLandingPreviewFromParams({ id: 'g1' })).toEqual({ name: undefined, category: undefined, joinPolicy: undefined, memberCount: undefined, invited: false });
        expect(inviteLandingPreviewFromParams({ memberCount: 'lots' }).memberCount).toBeUndefined();
        expect(inviteLandingFacts({ memberCount: 1 })).toBe('1 member');
        expect(inviteLandingFacts({})).toBe('');
    });
});
