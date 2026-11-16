/**
 * The Messages list's order on the web (core chat-list-order.ts, the phone's rule too; Marty, 16 Nov 2026): every chat by
 * its newest line, newest first, the member's own lines included; a chat with no line by when it was made. Unread is the
 * row's badge and bold, never the order. Group, event and direct chats and chats with other communities alike, in one
 * list; a muted chat moves too. Transactions keeps its own first rule (a listing still active or pending above the rest)
 * and within each part the same newest first.
 *
 * A line sent from this tab moves its chat to the top at once (`noteLineSentHere`), before the community's list knows it,
 * and stays there until a list asked for after the send shows a newer line in that chat (`settleChatListSends`). Memory
 * only, for the tab's life, as its pending lines are (lib/pending-chat-lines.ts): it outlives the chat page, which
 * unmounts when the member leaves the tab. A chat with another community needs none: its newest line is written in this
 * browser as it is sent (lib/outside-chat-store.ts addMine).
 */
import { useSyncExternalStore } from 'react';
import { chatMovedAt, movedAtWithSend, newestChatsFirst, sentHere, sentHereSettled, type ChatSentHere } from '@beanpool/core';
import type { Conversation } from './api';
import type { OutsideChat } from './outside-chat-store';
import { inConversationTab, type ConversationTab } from './conversation-tabs';

/** One row of the list: a chat in this community, or a chat with someone in another (open ones only). */
export type ChatListRow = { kind: 'chat'; conv: Conversation } | { kind: 'outside'; chat: OutsideChat };

type Listed = Pick<Conversation, 'id' | 'lastMessageAt' | 'createdAt'>;

let sends: ReadonlyMap<string, ChatSentHere> = new Map();
/** Lists asked for so far in this tab: a send carries the count at its time, and only a later ask can settle it. */
let asks = 0;
const listeners = new Set<() => void>();

function put(next: ReadonlyMap<string, ChatSentHere>) {
    sends = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** The sends from this tab still counted, as a map that changes only when one does. */
export function useChatListSends(): ReadonlyMap<string, ChatSentHere> {
    return useSyncExternalStore(subscribe, () => sends);
}

/** A chat's own time in the community's list: its newest line, else when it was made. */
export function listedMovedAt(conv: Pick<Conversation, 'lastMessageAt' | 'createdAt'>): number {
    return chatMovedAt(conv.lastMessageAt, conv.createdAt);
}

/** A chat with another community's time: its newest line, else its last change in this browser. */
function outsideMovedAt(chat: Pick<OutsideChat, 'lastAt' | 'updatedAt'>): number {
    return chatMovedAt(chat.lastAt, chat.updatedAt);
}

/** A list is being asked for: its mark, for `settleChatListSends` when it answers. */
export function chatListAskBegins(): number {
    return ++asks;
}

/**
 * The member sent a line in `conversationId` from this tab: the chat goes to the top of the list at once. `convs` and
 * `outside`: the list as it stands, so the chat goes above every chat in it whatever this browser's clock says.
 */
export function noteLineSentHere(conversationId: string, convs: readonly Listed[], outside: readonly Pick<OutsideChat, 'lastAt' | 'updatedAt'>[] = [], now: number = Date.now()) {
    const own = convs.find((c) => c.id === conversationId);
    const listed = [
        ...convs.map((c) => movedAtWithSend(listedMovedAt(c), sends.get(c.id))),
        ...outside.map(outsideMovedAt),
    ];
    const next = new Map(sends);
    next.set(conversationId, sentHere(own ? listedMovedAt(own) : 0, listed, now, asks));
    put(next);
}

/**
 * The community's list answered the ask marked `answerMark`: each send it shows a newer line for, asked after the send, is
 * the list's to order from now on. A send in a chat the list no longer has goes too: there is no row for it.
 */
export function settleChatListSends(convs: readonly Listed[], answerMark: number) {
    if (sends.size === 0) return;
    const byId = new Map(convs.map((c) => [c.id, c]));
    let changed = false;
    const next = new Map(sends);
    for (const [id, sent] of sends) {
        const conv = byId.get(id);
        if (!conv ? answerMark > sent.mark : sentHereSettled(sent, listedMovedAt(conv), answerMark)) {
            next.delete(id);
            changed = true;
        }
    }
    if (changed) put(next);
}

/** A Transactions row whose listing is still live: above the rest under that chip, as before. */
const liveListing = (row: ChatListRow) => row.kind === 'chat' && ['active', 'pending'].includes(row.conv.postStatus || '');

/**
 * The rows under a chip, in the order drawn. Chats with other communities sit under All and Direct (they are direct chats
 * and carry no listing), by their newest line among the rest.
 */
export function orderChatList(
    convs: readonly Conversation[],
    outside: readonly OutsideChat[],
    tab: ConversationTab,
    sent: ReadonlyMap<string, ChatSentHere> = sends,
): ChatListRow[] {
    const rows: ChatListRow[] = convs.filter((c) => inConversationTab(c, tab)).map((conv) => ({ kind: 'chat', conv }));
    if (tab === 'all' || tab === 'direct') for (const chat of outside) if (chat.state === 'open') rows.push({ kind: 'outside', chat });
    const ordered = newestChatsFirst(rows, (row) => (row.kind === 'chat'
        ? movedAtWithSend(listedMovedAt(row.conv), sent.get(row.conv.id))
        : outsideMovedAt(row.chat)));
    if (tab !== 'transactions') return ordered;
    return [...ordered.filter(liveListing), ...ordered.filter((row) => !liveListing(row))];
}

/** For tests: a fresh tab. */
export function resetChatListSendsForTest() {
    asks = 0;
    put(new Map());
}
