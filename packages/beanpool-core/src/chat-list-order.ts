/**
 * The order of a chat list, one rule for both apps (Marty, 16 Nov 2026: "when someone [posts] a chat in a group it pushes
 * the group to the top for everyone. but not the person who entered the chat"; WhatsApp is the reference).
 *
 * - **Newest line first.** A chat moves to the top for everyone in it when a line is posted, the sender included. A chat
 *   with no line yet sits by when it was made. Groups, events, direct chats and chats with other communities alike; a
 *   muted chat moves too, quietly.
 * - **Unread is never the order.** It is the row's badge and bold. An unread chat from last week stays below a chat read a
 *   minute ago.
 * - **A line sent here moves its chat at once.** The list the community sends knows the line only once it has it, and a
 *   list asked for before then would put the chat back. So a device keeps, for each chat it sent in, the time it sent and
 *   the time the chat had in its list then (`sentHere`), and counts the send until a list asked for after it shows a newer
 *   line in that chat (`sentHereSettled`). A line that never got there keeps its chat at the top, as its words wait there.
 *
 * Pure: no screen, no storage. Each app keeps its own sends in memory.
 */

/** A time as the apps hold one: an ISO string from a server, or milliseconds from a device's own store. */
export type ChatTime = string | number | null | undefined;

/** Milliseconds since 1970 for a time, or 0 when it is none or doesn't read as one. */
export function chatTimeMs(at: ChatTime): number {
    if (at === null || at === undefined || at === '') return 0;
    const ms = typeof at === 'number' ? at : Date.parse(at);
    return Number.isFinite(ms) ? ms : 0;
}

/** When a chat last moved: its newest line, else when it was made; 0 when neither reads as a time. */
export function chatMovedAt(lastLineAt: ChatTime, madeAt?: ChatTime): number {
    return chatTimeMs(lastLineAt) || chatTimeMs(madeAt);
}

/** Newest first by `movedAt`, ties keeping the order they came in. Never sorts `chats` itself. */
export function newestChatsFirst<T>(chats: readonly T[], movedAt: (chat: T) => number): T[] {
    return chats
        .map((chat, place) => ({ chat, place, at: movedAt(chat) }))
        .sort((a, b) => (b.at - a.at) || (a.place - b.place))
        .map((e) => e.chat);
}

/** A line this device sent in a chat, for that chat's place in this device's list. */
export interface ChatSentHere {
    /** The chat's time in this device's list from the send on: the top of the list. */
    readonly at: number;
    /** The chat's own time in the list when the line was sent. */
    readonly before: number;
    /** Lists asked for up to the send carry this mark or less; only one asked for after it can settle the send. */
    readonly mark: number;
}

/**
 * A send's entry. `listed`: every chat's time in the list as it stands, the chat's own among them. The send takes the top
 * at once, whatever this device's clock says against the community's: a clock behind would otherwise leave it under
 * chats whose lines came after its last read.
 */
export function sentHere(chatBefore: number, listed: readonly number[], now: number, mark: number): ChatSentHere {
    const top = listed.reduce((max, at) => Math.max(max, at), 0);
    return { at: Math.max(now, top + 1), before: chatBefore, mark };
}

/**
 * Whether a list answer settles a send: it was asked for after the send (`answerMark` above the send's mark) and shows a
 * newer line in the chat than it had then. The list's own time counts from there; until then the send's.
 */
export function sentHereSettled(sent: ChatSentHere, listedMovedAt: number, answerMark: number): boolean {
    return answerMark > sent.mark && listedMovedAt > sent.before;
}

/** A chat's time on this device's list: its own, or a send from here not yet settled, whichever is later. */
export function movedAtWithSend(listedMovedAt: number, sent: ChatSentHere | undefined): number {
    return sent ? Math.max(listedMovedAt, sent.at) : listedMovedAt;
}
