/**
 * The Chat tab's top (slice T0, DESIGN-forums-messaging-joint-fable.md §2.1): Chats · Forum where the forum is on, nothing
 * where it is off or unsaid, and a Forum side that goes back to Chats when the forum goes away.
 */
import { describe, expect, it } from 'vitest';
import { CHAT_SIDES, chatSideShown, chatSides, t } from '../index.js';

describe('the Chat tab\'s sides', () => {
    it('Chats then Forum, each a word shown through t()', () => {
        expect(CHAT_SIDES.map((s) => s.id)).toEqual(['chats', 'forum']);
        expect(CHAT_SIDES.map((s) => t(s.label))).toEqual(['Chats', 'Forum']);
        expect(Object.isFrozen(CHAT_SIDES)).toBe(true);
    });

    it('both where the forum is on; none where the owners switched it off, or the server says nothing', () => {
        expect(chatSides({ forum: true }).map((s) => s.id)).toEqual(['chats', 'forum']);
        expect(chatSides({})).toEqual([]);
        expect(chatSides({ forum: false })).toEqual([]);
        expect(chatSides(null)).toEqual([]);
        expect(chatSides(undefined)).toEqual([]);
        // Only a real true: a node that sends anything else has no forum (core forumOn).
        expect(chatSides({ forum: 'yes' })).toEqual([]);
    });

    it('the side drawn: the Forum only while the forum is on, else Chats', () => {
        expect(chatSideShown('forum', { forum: true })).toBe('forum');
        expect(chatSideShown('chats', { forum: true })).toBe('chats');
        expect(chatSideShown('forum', {})).toBe('chats');
        expect(chatSideShown('forum', null)).toBe('chats');
        expect(chatSideShown('chats', null)).toBe('chats');
    });
});
