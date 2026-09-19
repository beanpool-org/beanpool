import { describe, it, expect } from 'vitest';
import { initialTalkView, initialPeopleView, isPeopleView } from '../talk-views';

// The header's unread landing pushes Talk with view=messages&filter=unread. That view param used to survive
// on the route, and People (mounted inside Talk, reading the same params) started from it: three pills with
// none selected and nothing below them.
describe('Talk and People start on a view they have a page for', () => {
    it('the unread landing then People: People starts on a real pill (Community)', () => {
        expect(initialPeopleView('messages')).toBe('community');
        expect(initialPeopleView('')).toBe('community');
        expect(initialPeopleView(undefined)).toBe('community');
    });

    it('People keeps the deep links that name a pill', () => {
        expect(initialPeopleView('friends')).toBe('friends');
        expect(initialPeopleView('invites')).toBe('invites');
        expect(initialPeopleView('community')).toBe('community');
        expect(isPeopleView('messages')).toBe(false);
    });

    it('Talk starts on People only when asked by name; view=messages no longer mounts People for a frame', () => {
        expect(initialTalkView('messages')).toBe('messages');
        expect(initialTalkView('people')).toBe('people');
        expect(initialTalkView('')).toBe('messages');
        expect(initialTalkView(undefined)).toBe('messages');
    });

    it('Talk has three views: Messages | Groups | People (groups decision 6)', () => {
        expect(initialTalkView('groups')).toBe('groups');
        expect(initialPeopleView('groups')).toBe('community');
    });
});
