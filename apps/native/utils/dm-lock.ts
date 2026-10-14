/**
 * A direct message leaves this phone encrypted or not at all.
 *
 * The privacy policy tells members the server stores direct messages "in a form only the two of you can read". Until
 * now the phone fell back to readable `plaintext-v1` whenever it could not resolve the other person's key or the
 * encryption threw, so that was true of most lines, not all. Now a line that cannot be locked is not sent: db.ts
 * throws DmNotLockedError before anything is written or sent, the chat puts the words back in the box with one plain
 * line, and the next Send asks the node for the conversation again. The node refuses the readable form into a DM as
 * well (`dm_not_encrypted`), for the apps that still send it.
 *
 * A group, event or enterprise chat is node-readable by design (the node moderates and pushes it, and the chat says
 * so): its lines stay `plaintext-v1`.
 */

import { isDmPinStoreError, isDmPinsFullError } from './dm-peer-pins';
import { isDmGuardUnreadError } from './dm-guard-list';

/** Chats the node has to read. Every other conversation is a direct message. */
const NODE_READABLE_CHATS: ReadonlySet<string> = new Set(['group_thread', 'event_thread', 'enterprise_thread']);

export function isNodeReadableChatType(type: string | null | undefined): boolean {
    return !!type && NODE_READABLE_CHATS.has(type);
}

/** What a DM line that could not be locked throws, before anything is written or sent. */
export class DmNotLockedError extends Error {
    constructor() {
        super("This message couldn't be locked yet.");
        this.name = 'DmNotLockedError';
    }
}

export function isDmNotLocked(e: unknown): e is DmNotLockedError {
    return e instanceof DmNotLockedError || (e as { name?: unknown } | null)?.name === 'DmNotLockedError';
}

/** The one line the member sees; the words stay where they typed them. */
export function dmNotLockedLine(peerName?: string | null): string {
    const name = peerName?.trim();
    return `This message couldn't be locked for ${name && name !== 'Loading...' ? name : 'the other person'} yet, so it wasn't sent. Try again in a moment.`;
}

/**
 * What a DM line throws when the node now lists someone else in place of the key this phone pinned for the chat
 * (utils/dm-peer-pins.ts), before anything is written or sent: nothing is sealed to a key the member hasn't accepted.
 */
export class DmKeyChangedError extends Error {
    constructor() {
        super('The key behind this chat changed, so the message wasn\'t sent.');
        this.name = 'DmKeyChangedError';
    }
}

export function isDmKeyChanged(e: unknown): e is DmKeyChangedError {
    return e instanceof DmKeyChangedError || (e as { name?: unknown } | null)?.name === 'DmKeyChangedError';
}

/** The one line the member sees while a key change waits (and for a send it refused): under the box, which stays disabled. */
export function dmKeyChangedLine(peerName?: string | null): string {
    const name = peerName?.trim();
    return `The key behind ${name && name !== 'Loading...' ? name : 'this chat'} changed, so sending is paused.`;
}

/**
 * What goes back in the box after a send that couldn't be locked: the unsent words, and anything typed while it was
 * trying underneath them. Neither is lost.
 */
export function restoredDraft(unsent: string, typedSince: string): string {
    const since = typedSince.trim();
    return since ? `${unsent}\n${since}` : unsent;
}

/** The phone couldn't read its group key memory (group-chat-keys.ts GroupChatKeyError, code 'store'): nothing went. */
export function isKeyStoreUnread(e: unknown): boolean {
    const x = e as { name?: unknown; code?: unknown } | null;
    return x?.name === 'GroupChatKeyError' && x.code === 'store';
}

/**
 * The line the DM screen shows for a send that threw, when the words go back in the box: a line that couldn't be locked,
 * a key memory that couldn't be read (every send asks it first, a DM's too: #1815 review), a key change waiting for the
 * member, DM pins that couldn't be read, a new chat in a community whose pins are full (utils/dm-peer-pins.ts, §3.4
 * amendment 6), or a DM list that couldn't be read (utils/dm-guard-list.ts, amendment 7). Null: anything else, an alert as before.
 */
export function refusedSendNotice(e: unknown, peerName?: string | null): string | null {
    if (isDmNotLocked(e)) return dmNotLockedLine(peerName);
    if (isDmKeyChanged(e)) return dmKeyChangedLine(peerName);
    if (isDmPinStoreError(e) || isDmPinsFullError(e) || isDmGuardUnreadError(e)) return (e as Error).message;
    if (isKeyStoreUnread(e)) return (e as Error).message;
    return null;
}
