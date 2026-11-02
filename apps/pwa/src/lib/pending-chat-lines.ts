/**
 * The lines this tab is sending: the member's words, from Enter until the node's own row for them comes back.
 *
 * A pending line is shown as the member's own words with no check, so nothing a node sends may ever be taken for one. That
 * holds by construction: this is its own store of its own type, a line gets in only by sendChatLine (the member pressing
 * Send), and no row is ever read for it. The screen draws these after every row it has checked, and a row's own fields
 * decide nothing here: only its id, which takes the line away once the row itself is on screen.
 *
 * It outlives the chat page, which unmounts when the member leaves the tab: a send carries on, and one that fails stays
 * here with its words, for that chat's list row and its thread to show. Memory only: the words are never written anywhere,
 * and go with the tab, as a draft's do.
 *
 * Each chat has its own queue, so lines go in the order they were typed, each written after the one before it, and a chat
 * whose node has stopped answering holds up no other chat. SEND_BOUND_MS is how long one line may go unanswered.
 */
import { useSyncExternalStore } from 'react';
import { t } from '@beanpool/core';

/** How long a send may go unanswered before its line says it wasn't delivered. Its Retry is safe whenever the node did get it. */
export const SEND_BOUND_MS = 30_000;

export interface PendingChatLine {
    /** The id the line is sealed to, and sent under: a Retry reuses it, so a node that has the line stores it once. */
    readonly id: string;
    readonly conversationId: string;
    /** The member who wrote it, the only one it is shown to. A sign-out reloads the tab, which takes these with it. */
    readonly owner: string;
    readonly text: string;
    readonly replyToId: string | null;
    readonly state: 'sending' | 'failed';
    /** The node took it, and its row is yet to come: still drawn as sending, as only a row that passed the chat's checks reads as sent. */
    readonly taken: boolean;
    /**
     * It was never stored: the node said no, or nothing left this browser. Its words can go back in the composer. Any other
     * failure may have reached the node, so those words stay on the line, whose Retry is the way to send them.
     */
    readonly refused: boolean;
}

export type NewChatLine = Pick<PendingChatLine, 'id' | 'conversationId' | 'owner' | 'text' | 'replyToId'>;
/** One attempt at one line. Anything it throws is a failure with no answer: the node may or may not have the line. */
export type SendChatLine = () => Promise<'taken' | 'refused'>;

/** The id a new line is written after, by the kind of chat it turns out to go to (a conversation's route is settled at the send). */
export interface LineAfter {
    dm: string | null;
    group: string | null;
}

/** What a chat's lines are written after: the last read's newest line, or a line the node took that no read has brought yet. */
interface ChatTail {
    read: LineAfter;
    taken: string | null;
}

let lines: readonly PendingChatLine[] = [];
const listeners = new Set<() => void>();
const queues = new Map<string, Promise<void>>();
const tails = new Map<string, ChatTail>();
/** The chat open on screen, whichever mount of the page shows it, and how that page reads it. */
let chatOnScreen: string | null = null;
let readChatOnScreen: (() => void) | null = null;
/** Chats whose failed line has been said out loud since they were last open: one notice, however many lines. */
const noticed = new Set<string>();

function put(next: readonly PendingChatLine[]) {
    lines = next;
    for (const listener of listeners) listener();
}

function change(id: string, patch: Partial<PendingChatLine>) {
    put(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
}

const held = (id: string) => lines.find((l) => l.id === id);

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Every pending line in this tab, as a list that changes only when one of them does. */
export function usePendingChatLines(): readonly PendingChatLine[] {
    return useSyncExternalStore(subscribe, () => lines);
}

export function isPendingChatLine(id: string): boolean {
    return !!held(id);
}

/** A line goes down as not delivered. When its chat isn't open, a notice says so once: the words wait in that chat. */
function notDelivered(id: string, refused = false) {
    const line = held(id);
    if (!line || line.taken) return;
    change(id, { state: 'failed', refused });
    if (chatOnScreen === line.conversationId || noticed.has(line.conversationId)) return;
    noticed.add(line.conversationId);
    window.alert(t('Message not delivered'));
}

/** The node took the line: the next line is written after it, and a read brings its row, or the line says it didn't arrive. */
function takenByNode(line: PendingChatLine) {
    const id = line.conversationId;
    tails.set(id, { read: tails.get(id)?.read ?? { dm: null, group: null }, taken: line.id });
    if (!held(line.id)) return;
    // Nobody is looking: the chat reads its row when it is next opened.
    if (chatOnScreen !== id) { discardChatLine(line.id); return; }
    change(line.id, { state: 'sending', taken: true, refused: false });
    readChatOnScreen?.();
    setTimeout(() => {
        if (!held(line.id)) return;
        if (chatOnScreen === id) change(line.id, { state: 'failed', taken: false });
        else discardChatLine(line.id);
    }, SEND_BOUND_MS);
}

/** One attempt, over within the bound. An answer that comes after it still counts: a line the node took late was taken. */
function attempt(id: string, send: SendChatLine): Promise<void> {
    const line = held(id);
    if (!line || line.state !== 'sending') return Promise.resolve();
    return new Promise((done) => {
        const stalled = setTimeout(() => {
            notDelivered(id);
            // Its answer may be all that was lost: then a read brings its row, and the line was delivered.
            if (chatOnScreen === line.conversationId) readChatOnScreen?.();
            done();
        }, SEND_BOUND_MS);
        send().then(
            (answer) => {
                clearTimeout(stalled);
                if (answer === 'taken') takenByNode(line); else notDelivered(id, true);
                done();
            },
            () => { clearTimeout(stalled); notDelivered(id); done(); },
        );
    });
}

function inTurn(line: NewChatLine, send: SendChatLine) {
    queues.set(line.conversationId, chatSettled(line.conversationId).then(() => attempt(line.id, send)));
}

/** The member sent a line. One this chat refused with the same words is replaced by it: nothing of that one was stored. */
export function sendChatLine(line: NewChatLine, send: SendChatLine) {
    const kept = lines.filter((l) => !(l.conversationId === line.conversationId && l.text === line.text && l.state === 'failed' && l.refused));
    put([...kept, { ...line, state: 'sending', taken: false, refused: false }]);
    inTurn(line, send);
}

/** Try a failed line again, under its own id. */
export function retryChatLine(id: string, send: SendChatLine) {
    const line = held(id);
    if (!line || line.state !== 'failed') return;
    change(id, { state: 'sending', taken: false, refused: false });
    inTurn(line, send);
}

export function discardChatLine(id: string) {
    put(lines.filter((l) => l.id !== id));
}

/** Once every line of this chat sent so far has had its answer: a photo goes after them, and is written after the last. */
export function chatSettled(conversationId: string): Promise<void> {
    return queues.get(conversationId) ?? Promise.resolve();
}

/**
 * A read of the chat landed: what a line written now comes after. A line the node took stays the newest until a read
 * carries it, so a read that started before the node took it can't take the chain back past it.
 */
export function noteChatRead(conversationId: string, rowIds: readonly string[], read: LineAfter) {
    const taken = tails.get(conversationId)?.taken ?? null;
    tails.set(conversationId, { read, taken: taken && !rowIds.includes(taken) ? taken : null });
}

/** What a line of this chat is written after, worked out as it goes. */
export function lineAfter(conversationId: string): LineAfter {
    const tail = tails.get(conversationId);
    return { dm: tail?.taken ?? tail?.read.dm ?? null, group: tail?.taken ?? tail?.read.group ?? null };
}

/** The rows on screen: a line with its row there is the row now. Nothing changes, and no one is told, when none is. */
export function forgetLinesWithRows(rowIds: readonly string[]) {
    const ids = new Set(rowIds);
    const kept = lines.filter((l) => !ids.has(l.id));
    if (kept.length !== lines.length) put(kept);
}

/** The page says which chat it shows, and how to read it when a line of that chat is answered. */
export function noteChatOnScreen(conversationId: string | null, read: (() => void) | null = null) {
    chatOnScreen = conversationId;
    readChatOnScreen = read;
    if (conversationId) noticed.delete(conversationId);
}

export function isChatOnScreen(conversationId: string): boolean {
    return chatOnScreen === conversationId;
}

/** Between tests: this module outlives a render. */
export function resetPendingChatLinesForTest() {
    lines = [];
    queues.clear();
    tails.clear();
    noticed.clear();
    chatOnScreen = null;
    readChatOnScreen = null;
}
