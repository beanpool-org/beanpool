/**
 * One chat experience, decided here.
 *
 * DMs, group chats, an enterprise's discussion thread and an event's chat are four data sources behind one
 * screen shape (chat parity, 2026-09-23). Everything that decides what a bubble SAYS or what tapping it
 * OFFERS lives in this file, pure, so both the shared components and vitest read the same rules — the two
 * screens drifted apart precisely because each carried its own copy of them.
 *
 * No React and no device modules here on purpose: utils/__tests__ runs in plain node.
 */

/** Authors may edit a text message for this long after sending (mirrors the node's window). */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

/** The one reaction row, in every kind of chat that has reactions. */
export const CHAT_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '😁'] as const;

/** What an author's own deletion reads as, and what a convenor's removal reads as. */
export const DELETED_BY_AUTHOR_TEXT = 'This message was deleted';
export const REMOVED_BY_CONVENOR_TEXT = 'Removed by a convenor';

/** An older node knows none of the new verbs. The app says this rather than showing its 403/404. */
export const NOT_AVAILABLE_YET = 'Not available on this community yet';

export type ChatKind = 'dm' | 'group' | 'enterprise' | 'event';

/** The one message shape the shared list, bubble and actions work in, whatever fetched it. */
export interface ChatMessage {
    id: string;
    /** Author's pubkey. `senderId` because that is what the DM screen's rows have always called it. */
    senderId: string;
    text: string;
    /** 'text' | 'image' | 'removed' | 'system' */
    type?: string;
    systemType?: string | null;
    metadata?: any;
    /** Optimistic-send state; absent once the node has it. */
    sendState?: 'sending' | 'failed';
    outgoing?: boolean;
    readByPeer?: boolean;
    edited?: boolean;
    editedAt?: string | null;
    rawTimestamp?: string | null;
    /** Already formatted for display ("14:05"). */
    timestamp?: string;
    /** Who said it, when the chat shows names (group, enterprise, event). */
    authorName?: string | null;
}

/** Who the viewer is in this chat, for the action rules below. */
export interface ChatViewer {
    kind: ChatKind;
    myPubkey?: string | null;
    /** False in a read-only chat, for an observer, or once someone has left. */
    canPost: boolean;
    /** A group's convenor or an event's host: may remove other people's messages. */
    isModerator?: boolean;
    now?: number;
}

export interface MessageActions {
    reply: boolean;
    react: boolean;
    edit: boolean;
    /** The author's own "delete for everyone". */
    delete: boolean;
    /** A convenor's or host's removal of somebody else's message. */
    remove: boolean;
}

const NO_ACTIONS: MessageActions = { reply: false, react: false, edit: false, delete: false, remove: false };

/** A system line (a join, a leave, an escrow event) is never a bubble anyone can act on. */
export function isSystemLine(m: { type?: string; senderId?: string; systemType?: string | null } | null | undefined): boolean {
    if (!m) return false;
    return m.type === 'system' || m.senderId === 'SYSTEM' || !!m.systemType;
}

/** A deleted or removed message: the node replaced its text and dropped its reactions. */
export function isTombstone(m: { type?: string; metadata?: any } | null | undefined): boolean {
    if (!m) return false;
    return m.type === 'removed' || m.metadata?.removed === true;
}

/**
 * The words a tombstone shows. The node stores one marker text per thread kind; the app ignores it and reads
 * `metadata.removedBy` instead, because that is the only field that tells an author's own delete from a
 * convenor's removal — and the two must not read the same.
 */
export function tombstoneText(m: { senderId?: string; metadata?: any } | null | undefined): string {
    const by = m?.metadata?.removedBy;
    if (by && m?.senderId && by === m.senderId) return DELETED_BY_AUTHOR_TEXT;
    if (by) return REMOVED_BY_CONVENOR_TEXT;
    // A node that removed a message before it recorded who did it: the neutral reading of the two.
    return DELETED_BY_AUTHOR_TEXT;
}

/** Still on its way to the node (or stuck): its id is a local one, so nothing server-side can be asked about it. */
function inFlight(m: ChatMessage): boolean {
    return m.sendState === 'sending' || m.sendState === 'failed';
}

function isMine(m: ChatMessage, viewer: ChatViewer): boolean {
    return !!viewer.myPubkey && m.senderId === viewer.myPubkey;
}

/** Only a DM and a group chat carry the author's own verbs this round; enterprise and event threads refuse them. */
function authorVerbsAllowed(kind: ChatKind): boolean {
    return kind === 'dm' || kind === 'group';
}

/**
 * Edit: the author's own text, within the window, never an image, a system line, a tombstone or a message
 * still in flight (its id is a temp id the node does not know yet).
 */
export function canEditMessage(m: ChatMessage, viewer: ChatViewer): boolean {
    if (!authorVerbsAllowed(viewer.kind)) return false;
    if (!isMine(m, viewer) || !viewer.canPost) return false;
    if (isSystemLine(m) || isTombstone(m)) return false;
    if (m.type === 'image') return false;
    if (inFlight(m)) return false;
    if (!m.rawTimestamp) return false;
    const sentAt = new Date(m.rawTimestamp).getTime();
    if (isNaN(sentAt)) return false;
    return (viewer.now ?? Date.now()) - sentAt <= MESSAGE_EDIT_WINDOW_MS;
}

/** Delete for everyone: the author, any time, no window — but not a system line, a tombstone or an in-flight send. */
export function canDeleteMessage(m: ChatMessage, viewer: ChatViewer): boolean {
    if (!authorVerbsAllowed(viewer.kind)) return false;
    if (!isMine(m, viewer) || !viewer.canPost) return false;
    if (isSystemLine(m) || isTombstone(m)) return false;
    return !inFlight(m);
}

/** A convenor's (or an event host's) removal of a message. */
export function canRemoveMessage(m: ChatMessage, viewer: ChatViewer): boolean {
    if (viewer.kind === 'dm') return false;
    if (!viewer.isModerator) return false;
    if (isSystemLine(m) || isTombstone(m)) return false;
    if (inFlight(m)) return false;
    // A convenor's own message is a Delete, not a Remove. Where the author has no delete of their own —
    // an event chat, this round — the host keeps the power over every message that they already had.
    if (isMine(m, viewer)) return !authorVerbsAllowed(viewer.kind);
    return true;
}

/** React: whoever may post in the chat, on anything that is still a message. Not enterprise or event threads. */
export function canReactToMessage(m: ChatMessage, viewer: ChatViewer): boolean {
    if (!authorVerbsAllowed(viewer.kind)) return false;
    if (!viewer.canPost) return false;
    if (isSystemLine(m) || isTombstone(m)) return false;
    return !inFlight(m);
}

/** Reply: quoting needs a message id the node will recognise, so a failed send cannot be quoted. */
export function canReplyToMessage(m: ChatMessage, viewer: ChatViewer): boolean {
    if (!authorVerbsAllowed(viewer.kind)) return false;
    if (!viewer.canPost) return false;
    if (isSystemLine(m) || isTombstone(m)) return false;
    return m.sendState !== 'failed';
}

/** Everything tapping this bubble offers. One call so a screen can decide whether to open the bar at all. */
export function messageActions(m: ChatMessage | null | undefined, viewer: ChatViewer): MessageActions {
    if (!m) return NO_ACTIONS;
    return {
        reply: canReplyToMessage(m, viewer),
        react: canReactToMessage(m, viewer),
        edit: canEditMessage(m, viewer),
        delete: canDeleteMessage(m, viewer),
        remove: canRemoveMessage(m, viewer),
    };
}

export function hasAnyAction(a: MessageActions): boolean {
    return a.reply || a.react || a.edit || a.delete || a.remove;
}

/** WhatsApp-style day label: Today / Yesterday / "Mon, 12 May". */
export function formatDayLabel(d: Date, now: Date = new Date()): string {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    if (d.toDateString() === now.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

export interface ChatDaySeparator {
    id: string;
    type: 'day-separator';
    label: string;
}

export type ChatListItem = ChatMessage | ChatDaySeparator;

export function isDaySeparator(item: ChatListItem): item is ChatDaySeparator {
    return (item as ChatDaySeparator).type === 'day-separator';
}

/**
 * The rows an inverted list draws: day pills interleaved between messages from different calendar days, then
 * the whole thing reversed, because index 0 of an inverted list renders at the visual BOTTOM.
 *
 * `messages` comes in oldest-first, which is what both the DM database read and the node's thread read give.
 */
export function buildChatListItems(messages: ChatMessage[], now: Date = new Date()): ChatListItem[] {
    const items: ChatListItem[] = [];
    let lastDay: string | null = null;
    for (const m of messages) {
        const d = m.rawTimestamp ? new Date(m.rawTimestamp) : null;
        if (d && !isNaN(d.getTime())) {
            const dayKey = d.toDateString();
            if (dayKey !== lastDay) {
                items.push({ id: `day-${dayKey}`, type: 'day-separator', label: formatDayLabel(d, now) });
                lastDay = dayKey;
            }
        }
        items.push(m);
    }
    return items.reverse();
}

/**
 * Whether this bubble carries its author's name: only in a chat with more than two people, only for someone
 * else's message, and only for the first of a run by the same person.
 */
export function showsAuthorName(
    m: ChatMessage,
    previous: ChatMessage | null | undefined,
    viewer: Pick<ChatViewer, 'kind' | 'myPubkey'>,
): boolean {
    if (viewer.kind === 'dm') return false;
    if (isSystemLine(m)) return false;
    if (viewer.myPubkey && m.senderId === viewer.myPubkey) return false;
    if (!previous || isSystemLine(previous)) return true;
    return previous.senderId !== m.senderId;
}

/** The one time under a bubble, in every chat: 24-hour, zero-padded, and empty for an unreadable stamp. */
export function formatMessageTime(iso: string | null | undefined): string {
    if (!iso) return '';
    const t = new Date(iso);
    if (isNaN(t.getTime())) return '';
    return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export interface ReactionSummary {
    /** Each emoji once, in the order it was first used. */
    emojis: string[];
    counts: Record<string, number>;
    total: number;
    /** The emoji this viewer has on the message, if any — one reaction per person. */
    mine: string | null;
}

/** Reaction badges under a bubble. `metadata.reactions` is `[{emoji, author}]` in every kind of chat. */
export function reactionSummary(metadata: any, myPubkey?: string | null): ReactionSummary {
    const raw = Array.isArray(metadata?.reactions) ? metadata.reactions : [];
    const counts: Record<string, number> = {};
    const emojis: string[] = [];
    let mine: string | null = null;
    for (const r of raw) {
        const emoji = typeof r?.emoji === 'string' ? r.emoji : null;
        if (!emoji) continue;
        if (!(emoji in counts)) { counts[emoji] = 0; emojis.push(emoji); }
        counts[emoji] += 1;
        if (myPubkey && r.author === myPubkey) mine = emoji;
    }
    return { emojis, counts, total: emojis.reduce((n, e) => n + counts[e], 0), mine };
}

/**
 * An inverted list is at its newest message when its offset is ~0. A few pixels of slack so a resting list
 * that settled at 0.5 still counts as "at the bottom".
 */
export const AT_BOTTOM_SLACK_PX = 80;

export function isAtBottom(offsetY: number): boolean {
    return offsetY <= AT_BOTTOM_SLACK_PX;
}

/**
 * Stay at the bottom, but never yank someone reading history — the whole reason the group chat's
 * scroll-on-content-size-change was wrong (it yanked) and the DM's foreground-only rule was incomplete
 * (a message arriving while you sat at the bottom did not follow, so the keyboard hid it).
 */
export function shouldFollowNewMessages(s: { grew: boolean; isBackgroundPoll: boolean; atBottom: boolean }): boolean {
    if (!s.grew) return false;
    if (!s.isBackgroundPoll) return true; // my own send, an image, a resend: always show it
    return s.atBottom;
}

/**
 * An older node knows nothing of a group edit, a group reaction or the new delete: it answers 403 or 404.
 * The app says so plainly rather than showing a raw error, and keeps the node's own words for anything else.
 */
export function chatActionErrorMessage(status: number | null | undefined, nodeMessage?: string | null): string {
    if (status === 403 || status === 404 || status === 501) return NOT_AVAILABLE_YET;
    const msg = (nodeMessage || '').trim();
    return msg || 'Could not reach the node. Try again when you have signal.';
}

/**
 * The words of one message in a node-readable chat (group, enterprise, event). A tombstone reads by
 * `removedBy`, a system line as written, and anything else is decoded from base64.
 */
export function threadMessageDisplayText(
    m: { type?: string; senderId?: string; authorPubkey?: string; ciphertext?: string; metadata?: any },
    decode: (ciphertext: string, type: string) => string,
): string {
    const senderId = m.senderId ?? m.authorPubkey;
    if (isTombstone({ type: m.type, metadata: m.metadata })) return tombstoneText({ senderId, metadata: m.metadata });
    if (isSystemLine({ type: m.type, senderId, systemType: null })) return String(m.ciphertext ?? '');
    return decode(String(m.ciphertext ?? ''), String(m.type ?? 'text'));
}

/**
 * A node-readable chat's message, as the shared components want it. The node returns `authorPubkey`,
 * `ciphertext` and an ISO timestamp; the DM path already returns this shape from utils/db.
 */
export function normaliseThreadMessage(
    raw: any,
    decode: (ciphertext: string, type: string) => string,
    myPubkey?: string | null,
): ChatMessage {
    let metadata: any = raw?.metadata;
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { metadata = undefined; }
    }
    const senderId = String(raw?.authorPubkey ?? raw?.author_pubkey ?? '');
    const type = String(raw?.type ?? 'text');
    const rawTimestamp = raw?.timestamp ?? raw?.created_at ?? null;
    return {
        id: String(raw?.id ?? ''),
        senderId,
        text: threadMessageDisplayText({ type, senderId, ciphertext: raw?.ciphertext, metadata }, decode),
        type,
        systemType: raw?.systemType ?? raw?.system_type ?? null,
        metadata,
        outgoing: !!myPubkey && senderId === myPubkey,
        edited: !!(raw?.editedAt ?? raw?.edited_at),
        editedAt: raw?.editedAt ?? raw?.edited_at ?? null,
        rawTimestamp,
        timestamp: formatMessageTime(rawTimestamp),
        authorName: raw?.authorCallsign ?? raw?.author_callsign ?? null,
    };
}
