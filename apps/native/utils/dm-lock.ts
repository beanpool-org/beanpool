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
 * The one line under the box when first sight found lines it couldn't place (utils/dm-peer-pins.ts rule 5, design §3.4
 * amendment): no key is pinned, nothing is offered, so there is no Continue. It names no key. It never says the chat
 * reads as theirs: on a restored phone whose node served PUPPET's lines first (P23b, twin-first T2) the only lines that
 * read are the listed key's, and the person's own history is the part that "couldn't be verified" (#1872 handover 4).
 * A new chat is the first-sight path, where no code is shown, so the line says to check with them first (amendment 4 §3).
 */
export const DM_UNPLACED_LINE = "This phone can't match this chat to one key, so sending is off. What you can read here may not be from them. Check with them in person or on a call, then start a new chat.";

/**
 * The fixed line drawn in the slot of a DM line that opens only under the key offered in the pinned one's place (design
 * §3.4 amendment 2, item 3; db.ts getMessages fromOfferedKey): for every offer, first sight or not, never the line's words.
 */
export const DM_OFFERED_KEY_LINE = 'Sent from the new key. Shown after you continue.';

/** What the DM screen draws in a line's slot: the fixed line for a line from the offered key, else its shown text. */
export function dmLineSlotText(line: { text?: string | null; fromOfferedKey?: boolean }): string {
    return line.fromOfferedKey ? DM_OFFERED_KEY_LINE : (line.text ?? '');
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
 * member, or DM pins that couldn't be read (utils/dm-peer-pins.ts). Null: anything else, an alert as before.
 */
export function refusedSendNotice(e: unknown, peerName?: string | null): string | null {
    if (isDmNotLocked(e)) return dmNotLockedLine(peerName);
    if (isDmKeyChanged(e)) return dmKeyChangedLine(peerName);
    if ((e as { name?: unknown } | null)?.name === 'DmPinStoreError') return (e as Error).message;
    if (isKeyStoreUnread(e)) return (e as Error).message;
    return null;
}
