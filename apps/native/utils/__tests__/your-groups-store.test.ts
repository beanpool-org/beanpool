import { describe, it, expect } from 'vitest';
import { createYourGroupsStore } from '../your-groups-store';
import { chatMuteFromRows, chatMuteFromAnswer, muteMenuLabel, isMuted, groupsUnreadTotal, type YourChatsResponse } from '../your-groups';

const chat = (conversationId: string, unreadCount: number) => ({
    kind: 'group', badge: null, id: conversationId, conversationId, name: conversationId, avatarUrl: null, role: 'member',
    readOnly: false, lastMessage: null, unreadCount, mute: null, lastActivityAt: '',
}) as any;

/** A fetcher whose answers the test releases one at a time, like a slow connection. */
function slowNode() {
    const pending: Array<{ resolve: (r: YourChatsResponse) => void; reject: (e: Error) => void }> = [];
    let calls = 0;
    const fetcher = () => new Promise<YourChatsResponse>((resolve, reject) => { calls++; pending.push({ resolve, reject }); });
    const tick = () => new Promise(r => setTimeout(r, 0));
    return {
        fetcher,
        calls: () => calls,
        async answer(items: any[]) { pending.shift()!.resolve({ items, totalUnread: 0 }); await tick(); await tick(); },
        async fail(msg: string) { pending.shift()!.reject(new Error(msg)); await tick(); await tick(); },
    };
}

describe('your groups store: one list for Talk and Commons', () => {
    it('loading, then the list; a failed refresh keeps the list and says why', async () => {
        const node = slowNode();
        const store = createYourGroupsStore(node.fetcher);
        expect(store.getState()).toEqual({ items: null, error: null, loading: false });
        store.refresh();
        expect(store.getState().loading).toBe(true);
        await node.answer([chat('a', 1)]);
        expect(store.getState()).toMatchObject({ items: [chat('a', 1)], error: null, loading: false });
        store.refresh();
        await node.fail('Network request failed');
        expect(store.getState()).toMatchObject({ items: [chat('a', 1)], error: 'Network request failed', loading: false });
    });

    it('a burst of asks is one request in flight plus one follow-up, not a queue', async () => {
        const node = slowNode();
        const store = createYourGroupsStore(node.fetcher);
        store.refresh(); store.refresh(); store.refresh(); store.refresh();
        expect(node.calls()).toBe(1);
        await node.answer([]);
        expect(node.calls()).toBe(2);
        await node.answer([]);
        expect(node.calls()).toBe(2);
    });

    it('opening a chat clears its count at once, and an answer that left before the read cannot bring it back', async () => {
        let t = 1000;
        const node = slowNode();
        const store = createYourGroupsStore(node.fetcher, () => t);
        store.refresh();
        await node.answer([chat('a', 3), chat('b', 2)]);

        t = 2000;
        store.refresh();              // asked at 2000, before the read
        t = 3000;
        store.markRead('a');          // read at 3000
        expect(store.getState().items!.map((i: any) => i.unreadCount)).toEqual([0, 2]);
        await node.answer([chat('a', 3), chat('b', 2)]);   // the stale answer still says 3
        expect(store.getState().items!.map((i: any) => i.unreadCount)).toEqual([0, 2]);

        t = 4000;
        store.refresh();              // asked after the read: the node's word stands (a new message since)
        await node.answer([chat('a', 1), chat('b', 2)]);
        expect(store.getState().items!.map((i: any) => i.unreadCount)).toEqual([1, 2]);
    });

    it('tells listeners, keeps the same list object when nothing changed, and reset forgets it all', async () => {
        const node = slowNode();
        const store = createYourGroupsStore(node.fetcher);
        let heard = 0;
        const off = store.subscribe(() => { heard++; });
        store.refresh();
        await node.answer([chat('a', 1)]);
        const first = store.getState().items;
        store.refresh();
        await node.answer([chat('a', 1)]);
        expect(store.getState().items).toBe(first);
        expect(heard).toBeGreaterThan(0);
        off();
        store.reset();
        expect(store.getState()).toEqual({ items: null, error: null, loading: false });
    });
});

describe('an enterprise chat mute survives leaving the chat (PR #963 review round 1, B2)', () => {
    const ent = (id: string) => ({ ...chat(id, 3), kind: 'enterprise', badge: '🥖' });
    const always = (id: string) => ({ conversationId: id, mutedUntil: null, always: true });

    it('mute Always → leave → reopen: the header shows muted and the menu offers Unmute, which works', async () => {
        const node = slowNode();
        const store = createYourGroupsStore(node.fetcher);
        store.refresh();
        await node.answer([ent('bakery')]);

        // First visit: not muted; the member picks Always. The screen records it on the row.
        let mute = chatMuteFromRows(store.getState().items, 'bakery');
        expect(muteMenuLabel(mute)).toBe('Mute notifications');
        store.setMute('bakery', always('bakery'));
        expect(groupsUnreadTotal(store.getState().items)).toBe(0);

        // Leave, reopen: the screen starts from the row, before the chat loads.
        mute = chatMuteFromRows(store.getState().items, 'bakery');
        expect(isMuted(mute)).toBe(true);
        expect(muteMenuLabel(mute)).toBe('Unmute');

        // An older node's thread answer carries no mute: what we had stays. A current node's answer wins.
        expect(chatMuteFromAnswer({ messages: [] } as any, mute)).toEqual(always('bakery'));
        expect(chatMuteFromAnswer({ mute: always('bakery') }, null)).toEqual(always('bakery'));

        // Unmute.
        store.setMute('bakery', null);
        mute = chatMuteFromRows(store.getState().items, 'bakery');
        expect(muteMenuLabel(mute)).toBe('Mute notifications');
        expect(groupsUnreadTotal(store.getState().items)).toBe(3);
        expect(chatMuteFromAnswer({ mute: null }, always('bakery'))).toBeNull();
    });

    it('the next refresh from the node shows the mute too (the node answers with it)', async () => {
        const node = slowNode();
        const store = createYourGroupsStore(node.fetcher);
        store.refresh();
        await node.answer([{ ...ent('bakery'), mute: always('bakery') }]);
        expect(muteMenuLabel(chatMuteFromRows(store.getState().items, 'bakery'))).toBe('Unmute');
    });

    it('a chat not in the list starts unmuted and setMute leaves the list alone', async () => {
        const node = slowNode();
        const store = createYourGroupsStore(node.fetcher);
        expect(chatMuteFromRows(store.getState().items, 'x')).toBeNull();
        store.setMute('x', always('x'));
        expect(store.getState().items).toBeNull();
        store.refresh();
        await node.answer([ent('bakery')]);
        const before = store.getState().items;
        store.setMute('x', always('x'));
        expect(store.getState().items).toBe(before);
    });
});
