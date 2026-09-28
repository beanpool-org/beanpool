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
 * What goes back in the box after a send that couldn't be locked: the unsent words, and anything typed while it was
 * trying underneath them. Neither is lost.
 */
export function restoredDraft(unsent: string, typedSince: string): string {
    const since = typedSince.trim();
    return since ? `${unsent}\n${since}` : unsent;
}
