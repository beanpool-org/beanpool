/**
 * The Messages list's order (lib/chat-list-order.ts; Marty, 16 Nov 2026: "when someone [posts] a chat in a group it pushes
 * the group to the top for everyone. but not the person who entered the chat"). WhatsApp's rule: a line moves its chat to
 * the top for everyone in it, the sender included; unread is the badge, not the order.
 *
 * One table over who is looking (the sender, the other member) x the kind of chat (direct, group, event, another
 * community's) x what happened (a line sent, a line received, that line read): the chat is first in that member's list,
 * under All and under its own chip.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Conversation } from './api';
import type { OutsideChat } from './outside-chat-store';
import type { ConversationTab } from './conversation-tabs';
import { chatListAskBegins, noteLineSentHere, orderChatList, resetChatListSendsForTest, settleChatListSends } from './chat-list-order';

const iso = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString();
const ms = (minute: number) => Date.UTC(2026, 10, 16, 10, minute);

const conv = (id: string, type: Conversation['type'], lastAt: number | null, extra: Partial<Conversation> = {}): Conversation => ({
    id, type, name: id, participants: ['me', 'them'], createdBy: 'me', createdAt: iso(-60), lastMessageAt: lastAt === null ? null : iso(lastAt),
    unreadCount: 0, ...extra,
});
const outside = (id: string, lastAt: number | null): OutsideChat => ({
    id, peerKey: 'k'.repeat(64), peerHome: 'https://hillside.example', peerName: 'Cy', state: 'open', restored: false,
    updatedAt: ms(-60), lastText: lastAt === null ? null : 'hello', lastAt: lastAt === null ? null : ms(lastAt),
} as OutsideChat);

/**
 * Each member's list as the community last gave it, at 10:05: a chat of each kind from earlier, a chat read at 10:05 (the
 * newest), and one with three unread lines from 09:00 (stale).
 */
function before() {
    return {
        convs: [
            conv('dm', 'dm', 1),
            conv('group', 'group_thread', 2),
            conv('event', 'event_thread', 3),
            conv('fresh', 'dm', 5),
            conv('stale', 'dm', -60, { unreadCount: 3 }),
        ],
        outside: [outside('outside', 4)],
    };
}

type Kind = 'dm' | 'group' | 'event' | 'outside';
const ownChip: Record<Kind, ConversationTab> = { dm: 'direct', group: 'groups', event: 'groups', outside: 'direct' };
const ids = (convs: Conversation[], out: OutsideChat[], tab: ConversationTab) =>
    orderChatList(convs, out, tab, undefined).map((r) => (r.kind === 'chat' ? r.conv.id : r.chat.id));

/** The list answer after the line at 10:06 got to the community, as it reaches `who`. */
function withLine(list: ReturnType<typeof before>, kind: Kind, who: 'sender' | 'other') {
    if (kind === 'outside') {
        // A chat with another community keeps its lines in this browser: its newest is written as it is sent or arrives.
        return { convs: list.convs, outside: list.outside.map((o) => ({ ...o, lastAt: ms(6) })) };
    }
    return {
        convs: list.convs.map((c) => (c.id === kind ? { ...c, lastMessageAt: iso(6), unreadCount: who === 'other' ? 1 : 0 } : c)),
        outside: list.outside,
    };
}

beforeEach(() => resetChatListSendsForTest());

describe('chat list order: newest line first, for everyone in the chat', () => {
    const kinds: Kind[] = ['dm', 'group', 'event', 'outside'];
    const table: Array<{ who: 'sender' | 'other'; kind: Kind; step: 'send' | 'receive' | 'read' }> = [];
    for (const kind of kinds) {
        table.push({ who: 'sender', kind, step: 'send' });
        table.push({ who: 'sender', kind, step: 'read' });
        table.push({ who: 'other', kind, step: 'receive' });
        table.push({ who: 'other', kind, step: 'read' });
    }

    it.each(table)('$who, $kind chat, after $step: that chat is first, under All and its own chip', ({ who, kind, step }) => {
        let list = before();
        if (who === 'sender') {
            // The sender's tab: the line leaves; the list as the community last gave it, which doesn't know the line yet.
            const mark = chatListAskBegins();
            settleChatListSends(list.convs, mark);
            if (kind === 'outside') list = withLine(list, kind, who);
            // This browser's clock behind the community's by a minute: the send still goes to the top.
            else noteLineSentHere(kind, list.convs, list.outside, ms(4));
            for (const tab of ['all', ownChip[kind]] as const) expect(ids(list.convs, list.outside, tab)[0]).toBe(kind);
            if (step === 'read') {
                // The next list, asked after the send, has the line (the sender has nothing unread): still first.
                const next = withLine(list, kind, who);
                settleChatListSends(next.convs, chatListAskBegins());
                for (const tab of ['all', ownChip[kind]] as const) expect(ids(next.convs, next.outside, tab)[0]).toBe(kind);
            }
            return;
        }
        // The other member: the line arrives, unread; then they read it, and it stays where the line put it.
        list = withLine(list, kind, who);
        if (step === 'read') list = { ...list, convs: list.convs.map((c) => (c.id === kind ? { ...c, unreadCount: 0 } : c)) };
        for (const tab of ['all', ownChip[kind]] as const) expect(ids(list.convs, list.outside, tab)[0]).toBe(kind);
    });

    it('unread is never the order: a stale unread chat stays below a newer read one, at the bottom', () => {
        const { convs, outside: out } = before();
        const order = ids(convs, out, 'all');
        expect(order).toEqual(['fresh', 'outside', 'event', 'group', 'dm', 'stale']);
        expect(ids(convs, out, 'direct')).toEqual(['fresh', 'outside', 'dm', 'stale']);
    });

    it('a chat with no line yet sits by when it was made; a muted chat moves like any other', () => {
        const { convs, outside: out } = before();
        const made = conv('made', 'dm', null, { createdAt: iso(7) });
        const muted = conv('muted', 'group_thread', 8, { mute: { mutedUntil: null, always: true } });
        expect(ids([...convs, made, muted], out, 'all').slice(0, 2)).toEqual(['muted', 'made']);
        expect(ids([...convs, conv('old-empty', 'dm', null, { createdAt: iso(-90) })], out, 'all').at(-1)).toBe('old-empty');
    });

    it('Transactions keeps a live listing above the rest, and newest first within each part', () => {
        const trades = [
            conv('done-new', 'dm', 9, { postId: 'p1', postStatus: 'completed' }),
            conv('live-old', 'dm', 1, { postId: 'p2', postStatus: 'active', unreadCount: 2 }),
            conv('live-new', 'dm', 6, { postId: 'p3', postStatus: 'pending' }),
            conv('done-old', 'dm', 2, { postId: 'p4', postStatus: 'cancelled', unreadCount: 5 }),
        ];
        expect(ids(trades, [outside('outside', 10)], 'transactions')).toEqual(['live-new', 'live-old', 'done-new', 'done-old']);
    });
});

describe('a line sent here: at once, and kept until the list knows it', () => {
    it('an answer asked before the send cannot put the chat back', () => {
        const { convs, outside: out } = before();
        const askedBefore = chatListAskBegins();
        noteLineSentHere('group', convs, out, ms(6));
        // That answer lands after the send, without the line: the group stays first.
        settleChatListSends(convs, askedBefore);
        expect(ids(convs, out, 'all')[0]).toBe('group');
        // An answer asked after the send, before the line got there: still first.
        settleChatListSends(convs, chatListAskBegins());
        expect(ids(convs, out, 'all')[0]).toBe('group');
        // The one with the line settles it: from here the list's own time, which is the newest.
        const next = convs.map((c) => (c.id === 'group' ? { ...c, lastMessageAt: iso(6) } : c));
        settleChatListSends(next, chatListAskBegins());
        expect(ids(next, out, 'all')[0]).toBe('group');
        // And a newer line elsewhere then goes above it, as it would for anyone.
        const later = next.map((c) => (c.id === 'dm' ? { ...c, lastMessageAt: iso(7), unreadCount: 1 } : c));
        expect(ids(later, out, 'all').slice(0, 2)).toEqual(['dm', 'group']);
    });

    it('two sends: the later is first', () => {
        const { convs, outside: out } = before();
        noteLineSentHere('dm', convs, out, ms(6));
        noteLineSentHere('event', convs, out, ms(6));
        expect(ids(convs, out, 'all').slice(0, 2)).toEqual(['event', 'dm']);
    });

    it('a send in a chat the list no longer has goes with the next answer asked after it', () => {
        const { convs, outside: out } = before();
        const back = [...convs, conv('gone', 'dm', 0)];
        noteLineSentHere('gone', convs, out, ms(6));
        // While it is counted, the chat would be first wherever it shows.
        expect(ids(back, out, 'all')[0]).toBe('gone');
        settleChatListSends(convs, chatListAskBegins());
        // Gone from the next answer asked after it: when the chat is listed again it sits by its own line.
        expect(ids(back, out, 'all')[0]).toBe('fresh');
    });
});
