/**
 * The top of the Chat tab, one frame for both apps (slice T0; scratch/fable-design/DESIGN-forums-messaging-joint-fable.md
 * §2.1, Marty's answers to its questions 1 and 3, 13 and 14 Nov 2026).
 *
 * - **Two sides, Chats and Forum.** Where this community's forum is on (`features.forum`, core forumOn: every local
 *   community from the start, members only, until its owners switch it off), the switch takes the place of the big "Chat"
 *   title. Under Chats nothing moves: the phone's Messages · Groups · People, the search row, "Message requests" (where every
 *   outside thing will wait: requests from other communities, slice X3/X4, and group invitations, G2). The Forum side is the
 *   forum's own (F3 on the phone, F4 on the web fill it).
 * - **No forum, no switch.** A community whose owners switched the forum off, and a server from before it, say nothing:
 *   `chatSides` gives none, and the title "Chat" shows as before. The tab is called Chat either way.
 * - **A side that went away.** A member on the Forum side when the forum goes off is back on Chats (`chatSideShown`).
 *
 * Pure: no screen, no storage. Each app draws the switch in its own components with these words.
 */
import { forumOn } from './forum.js';
import { word, type WordKey } from './words.js';

export type ChatSide = 'chats' | 'forum';

export interface ChatSideEntry {
    readonly id: ChatSide;
    /** The side's name on the switch: a word() key, shown through t() where the switch is drawn. */
    readonly label: WordKey;
}

/** Both sides, in the order the switch draws them (the design's sketch: Chats left, Forum right). */
export const CHAT_SIDES: ReadonlyArray<ChatSideEntry> = Object.freeze([
    Object.freeze({ id: 'chats' as const, label: word('Chats', 'chat tab side') }),
    Object.freeze({ id: 'forum' as const, label: word('Forum', 'chat tab side') }),
]);

const NO_SIDES: ReadonlyArray<ChatSideEntry> = Object.freeze([]);

/**
 * The sides this community's Chat tab offers: both where its forum is on, none where it is off or the server is from before
 * the forum (the title "Chat" shows then, as it always has).
 */
export function chatSides(features: { forum?: unknown } | null | undefined): ReadonlyArray<ChatSideEntry> {
    return forumOn(features) ? CHAT_SIDES : NO_SIDES;
}

/** The side drawn: the one the member picked, unless it is the Forum and this community has none (any more). */
export function chatSideShown(picked: ChatSide, features: { forum?: unknown } | null | undefined): ChatSide {
    return picked === 'forum' && forumOn(features) ? 'forum' : 'chats';
}
