/**
 * Talk → Messages' order (core chat-list-order.ts, the web's rule too; Marty, 16 Nov 2026): every chat by its newest line,
 * newest first, the member's own included; a chat with no line yet by when it was made; a chat with someone in another
 * community among them by its newest line. Unread is the row's badge and bold, never the order, unless the member picks
 * the ✉ Unread sort themselves (the drawer's choice, as Beans: High and Low are): then unread first, newest first within.
 *
 * A line the member sends is a row in this phone's own store at once (utils/db.ts insertMessage writes it before the node
 * answers; a chat with another community, utils/outside-chat-store.ts addMine), so its chat is first at the next read of
 * the list, with no wait for a sync. Groups, events and enterprises are Talk → Groups (utils/your-groups-store.ts).
 *
 * Pure, so it is unit tested.
 */
import { chatMovedAt, newestChatsFirst } from '@beanpool/core';

export type TalkSort = 'recent' | 'unread' | 'credits_desc' | 'credits_asc';

/** What the order reads of a row of the list (utils/db.ts getConversations, or a chat with another community). */
export interface TalkRowTimes {
    /** Its newest line's time, null while it has none. */
    rawTimestamp?: string | null;
    /** When the chat was made. */
    createdAt?: string | null;
    unread?: number;
    postPrice_c?: number | null;
    pendingAmount_c?: number | null;
}

/** A row's time: its newest line, else when it was made. */
export function talkRowMovedAt(row: TalkRowTimes): number {
    return chatMovedAt(row.rawTimestamp, row.createdAt);
}

/** Whole hundredths of a Bean a row is about: its listing's price, else what its deal holds. */
const beansOf = (row: TalkRowTimes) => row.postPrice_c || row.pendingAmount_c || 0;

/** The rows in the order Talk → Messages draws them under `sortBy`. Never sorts `rows` itself. */
export function orderTalkRows<T extends TalkRowTimes>(rows: readonly T[], sortBy: TalkSort): T[] {
    const newest = newestChatsFirst(rows, talkRowMovedAt);
    if (sortBy === 'recent') return newest;
    const first = (row: T): number => {
        if (sortBy === 'unread') return (row.unread ?? 0) > 0 ? 0 : 1;
        // Compared exactly, in hundredths: High is the most first, Low the least.
        return sortBy === 'credits_desc' ? -beansOf(row) : beansOf(row);
    };
    return newest.map((row, place) => ({ row, place, key: first(row) }))
        .sort((a, b) => (a.key - b.key) || (a.place - b.place))
        .map((e) => e.row);
}
