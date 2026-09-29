/**
 * A direct message leaves this app encrypted or not at all.
 *
 * The privacy policy tells members the server stores direct messages "in a form only the two of you can read". Until
 * now the chat fell back to readable `plaintext-v1` whenever it could not find the other person's key, so that was
 * true of most lines, not all. Now a line that cannot be locked is not sent: the words stay in the composer with one
 * plain line saying so, and the next Send tries again. The node refuses the readable form into a DM as well
 * (`dm_not_encrypted`), for the apps that still send it.
 *
 * A group, event or enterprise chat is node-readable by design (the node moderates and pushes it, and the chat says
 * so): its lines stay `plaintext-v1`.
 */
import { encodePlaintext, encryptDM, type DMKeyContext } from './e2e-crypto';

/** Chats the node has to read. Everything else a member writes in is a direct message. */
const NODE_READABLE_CHATS = new Set(['group_thread', 'event_thread', 'enterprise_thread']);

interface ChatLike { id: string; type?: string | null; participants?: Array<string | null | undefined> | null }
interface Me { publicKey: string; privateKey: string }

export function isNodeReadableChat(conv: Pick<ChatLike, 'type'> | null | undefined): boolean {
    return !!conv?.type && NODE_READABLE_CHATS.has(conv.type);
}

/** What a line that could not be locked throws, before anything is sent. */
export class DmNotLockedError extends Error {
    constructor() {
        super("This message couldn't be locked yet.");
        this.name = 'DmNotLockedError';
    }
}

export function isDmNotLocked(e: unknown): e is DmNotLockedError {
    return e instanceof DmNotLockedError;
}

/** The one line the member sees; the words stay where they typed them. */
export function dmNotLockedLine(peerName?: string | null): string {
    return `This message couldn't be locked for ${peerName?.trim() || 'the other person'} yet, so it wasn't sent. Try again in a moment.`;
}

/** The key context of a two-person DM, or null when the other person isn't known yet (or it isn't a DM). */
export function dmKeyContext(conv: ChatLike | null | undefined, me: Me): DMKeyContext | null {
    if (!conv || conv.type !== 'dm' || !me?.privateKey) return null;
    const others = Array.from(new Set((conv.participants || []).filter((p): p is string => !!p && p !== me.publicKey)));
    if (others.length !== 1) return null;
    return { myEdPrivHex: me.privateKey, peerEdPubHex: others[0], conversationId: conv.id };
}

/**
 * Lock `text` (a message, an edit, or a photo's caption or picture) for this DM. Throws DmNotLockedError when the other
 * person's key can't be found or the encryption throws: never a readable fallback.
 */
export function lockForDm(text: string, conv: ChatLike | null | undefined, me: Me): { ciphertext: string; nonce: string } {
    const ctx = dmKeyContext(conv, me);
    if (!ctx) throw new DmNotLockedError();
    try {
        return encryptDM(text, ctx);
    } catch {
        throw new DmNotLockedError();
    }
}

/** A line for `conv` as it goes to the node: readable in a node-readable chat, locked everywhere else. */
export function payloadForChat(text: string, conv: ChatLike | null | undefined, me: Me): { ciphertext: string; nonce: string } {
    return isNodeReadableChat(conv) ? encodePlaintext(text) : lockForDm(text, conv, me);
}
