import { describe, it, expect } from 'vitest';
import { createYourGroupsStore } from '../your-groups-store';
import type { YourChatsResponse } from '../your-groups';

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
