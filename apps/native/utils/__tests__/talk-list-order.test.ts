/**
 * Talk's order on the phone (utils/talk-list-order.ts for Messages, utils/your-groups-store.ts for Groups; Marty, 16 Nov
 * 2026: "when someone [posts] a chat in a group it pushes the group to the top for everyone. but not the person who entered
 * the chat"). WhatsApp's rule: a line moves its chat to the top for everyone in it, the sender included; unread is the badge.
 *
 * One table over who is looking (the sender, the other member) x the kind of chat (direct and another community's under
 * Messages; group, event and enterprise under Groups) x what happened (a line sent, received, read): that chat is first.
 */
import { describe, it, expect } from 'vitest';
import { orderTalkRows, type TalkSort } from '../talk-list-order';
import { createYourGroupsStore } from '../your-groups-store';
import type { YourChat, YourChatsResponse } from '../your-groups';

const iso = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString();
const ms = (minute: number) => Date.UTC(2026, 10, 16, 10, minute);

// ── Messages: rows as utils/db.ts getConversations gives them, and a chat with another community as Talk maps it ──

const row = (id: string, lastAt: number | null, extra: Record<string, unknown> = {}) => ({
    id, type: 'dm', peer: id, rawTimestamp: lastAt === null ? null : iso(lastAt), createdAt: iso(-60), unread: 0, ...extra,
});
/** Talk's own mapping of an open chat with another community (chats.tsx): its newest line, else its last change. */
const outsideRow = (id: string, lastAt: number | null) => ({
    id, outside: true, peer: id, rawTimestamp: new Date(lastAt === null ? ms(-60) : ms(lastAt)).toISOString(), unread: 0,
});

/** The Messages list before, at 10:05: a direct chat and an outside chat from earlier, one read at 10:05, one unread since 09:00. */
const messagesBefore = () => [row('dm', 1), outsideRow('outside', 2), row('fresh', 5), row('stale', -60, { unread: 3 })];
const order = (rows: ReturnType<typeof messagesBefore>, sort: TalkSort = 'recent') => orderTalkRows(rows, sort).map((r) => r.id);

describe('Talk → Messages: newest line first, for everyone in the chat', () => {
    const table: Array<{ who: 'sender' | 'other'; kind: 'dm' | 'outside'; step: 'send' | 'receive' | 'read' }> = [];
    for (const kind of ['dm', 'outside'] as const) {
        table.push({ who: 'sender', kind, step: 'send' }, { who: 'sender', kind, step: 'read' });
        table.push({ who: 'other', kind, step: 'receive' }, { who: 'other', kind, step: 'read' });
    }

    it.each(table)('$who, $kind chat, after $step: that chat is first', ({ who, kind, step }) => {
        // The line at 10:06: on the sender's phone it is a row at once (insertMessage / addMine, before any answer), on the
        // other member's it comes with a sync, unread until they read it. The sender has nothing unread in it.
        const unread = who === 'other' && step === 'receive' ? 1 : 0;
        const rows = messagesBefore().map((r) => (r.id !== kind ? r
            : kind === 'outside' ? outsideRow('outside', 6) : { ...r, rawTimestamp: iso(6), unread }));
        expect(order(rows)[0]).toBe(kind);
    });

    it('unread is never the order: a stale unread chat stays below a newer read one, at the bottom', () => {
        expect(order(messagesBefore())).toEqual(['fresh', 'outside', 'dm', 'stale']);
    });

    it('a chat with no line yet sits by when it was made, not at the bottom', () => {
        const made = row('made', null, { createdAt: iso(7) });
        expect(order([...messagesBefore(), made])[0]).toBe('made');
        // One made long ago, with no line: below everything newer.
        expect(order([...messagesBefore(), row('old-empty', null, { createdAt: iso(-90) })]).at(-1)).toBe('old-empty');
    });

    it('✉ Unread, when the member picks it, puts unread first, newest first within; Beans sorts keep newest first in a tie', () => {
        const rows = [...messagesBefore(), row('unread-new', 4, { unread: 1 })];
        expect(order(rows, 'unread')).toEqual(['unread-new', 'stale', 'fresh', 'outside', 'dm']);
        const priced = [row('a', 1, { postPrice_c: 500 }), row('b', 2, { postPrice_c: 500 }), row('c', 3, { pendingAmount_c: 100 }), row('d', 4)];
        expect(order(priced as any, 'credits_desc')).toEqual(['b', 'a', 'c', 'd']);
        expect(order(priced as any, 'credits_asc')).toEqual(['d', 'c', 'b', 'a']);
    });

    it('never sorts the rows it is given', () => {
        const rows = messagesBefore();
        const copy = rows.map((r) => r.id);
        order(rows);
        expect(rows.map((r) => r.id)).toEqual(copy);
    });
});

// ── Groups: the one "Your groups" list (utils/your-groups-store.ts), ordered by the node, with this phone's sends ──

const chat = (conversationId: string, kind: YourChat['kind'], lastAt: number, extra: Partial<YourChat> = {}): YourChat => ({
    kind, badge: null, id: conversationId, conversationId, name: conversationId, avatarUrl: null, role: 'member', readOnly: false,
    lastMessage: null, unreadCount: 0, mute: null, lastActivityAt: iso(lastAt), ...extra,
});
/** The node's answer before, newest first as it sends it: one read at 10:05, then each kind from earlier, one unread since 09:00. */
const groupsBefore = () => [
    chat('fresh', 'group', 5), chat('event', 'event', 3), chat('enterprise', 'enterprise', 2), chat('group', 'group', 1),
    chat('stale', 'group', -60, { unreadCount: 3 }),
];
/** The node's answer once the line at 10:06 is in it, in the node's own order (engine/your-groups.ts sorts by lastActivityAt). */
const groupsWithLine = (id: string, unreadCount: number) => {
    const items = groupsBefore().map((c) => (c.conversationId === id ? { ...c, lastActivityAt: iso(6), unreadCount } : c));
    return items.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
};

/** A node whose answers the test releases one at a time. */
function slowNode() {
    const pending: Array<(r: YourChatsResponse) => void> = [];
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return {
        fetcher: () => new Promise<YourChatsResponse>((resolve) => { pending.push(resolve); }),
        async answer(items: YourChat[]) { pending.shift()!({ items, totalUnread: 0 }); await tick(); await tick(); },
    };
}
const ids = (store: ReturnType<typeof createYourGroupsStore>) => (store.getState().items ?? []).map((c) => c.conversationId);

describe('Talk → Groups: newest line first, for everyone in the chat', () => {
    const table: Array<{ who: 'sender' | 'other'; kind: 'group' | 'event' | 'enterprise'; step: 'send' | 'receive' | 'read' }> = [];
    for (const kind of ['group', 'event', 'enterprise'] as const) {
        table.push({ who: 'sender', kind, step: 'send' }, { who: 'sender', kind, step: 'read' });
        table.push({ who: 'other', kind, step: 'receive' }, { who: 'other', kind, step: 'read' });
    }

    it.each(table)('$who, $kind chat, after $step: that chat is first', async ({ who, kind, step }) => {
        // This phone's clock reads 10:04, behind the node's: a send still goes to the top.
        let t = ms(4);
        const node = slowNode();
        const store = createYourGroupsStore(node.fetcher, () => t);
        store.refresh();
        await node.answer(groupsBefore());
        expect(ids(store)[0]).toBe('fresh');
        if (who === 'sender') {
            t += 1;
            store.refresh();              // asked before the send; its answer comes after
            t += 1;
            store.noteSent(kind);         // at once, before any answer
            expect(ids(store)[0]).toBe(kind);
            await node.answer(groupsBefore());
            expect(ids(store)[0]).toBe(kind);
            if (step === 'read') {
                // The next answer, asked after the send, has the line: from here the node's own order, which agrees.
                t += 1;
                store.refresh();
                await node.answer(groupsWithLine(kind, 0));
                expect(ids(store)[0]).toBe(kind);
                // And a newer line elsewhere goes above it, as for anyone.
                t += 1;
                store.refresh();
                await node.answer(groupsWithLine(kind, 0).map((c) => (c.conversationId === 'stale' ? { ...c, lastActivityAt: iso(7) } : c))
                    .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1)));
                expect(ids(store).slice(0, 2)).toEqual(['stale', kind]);
            }
            return;
        }
        t += 1;
        store.refresh();
        await node.answer(groupsWithLine(kind, 1));
        expect(ids(store)[0]).toBe(kind);
        if (step === 'read') {
            store.markRead(kind);
            expect(ids(store)[0]).toBe(kind);
            expect(store.getState().items![0].unreadCount).toBe(0);
        }
    });

    it('a muted chat moves like any other', async () => {
        const node = slowNode();
        const store = createYourGroupsStore(node.fetcher, () => ms(4));
        store.refresh();
        await node.answer(groupsBefore().map((c) => (c.conversationId === 'group' ? { ...c, mute: { conversationId: 'group', mutedUntil: null, always: true } } : c)));
        store.noteSent('group');
        expect(ids(store)[0]).toBe('group');
    });

    it('a send in a chat the member has left goes with the next answer asked after it; a reset forgets every send', async () => {
        let t = ms(4);
        const node = slowNode();
        const store = createYourGroupsStore(node.fetcher, () => t);
        store.refresh();
        await node.answer(groupsBefore());
        store.noteSent('group');
        t += 1;
        store.refresh();
        await node.answer(groupsBefore().filter((c) => c.conversationId !== 'group'));
        t += 1;
        store.refresh();
        // Back in the list later, with nothing newer: by its own line again.
        await node.answer(groupsBefore());
        expect(ids(store)[0]).toBe('fresh');
        store.noteSent('event');
        store.reset();
        store.refresh();
        await node.answer(groupsBefore());
        expect(ids(store)[0]).toBe('fresh');
    });
});
