/**
 * A group stays a group (group chats slice 4; director's decision b, confirmation of #1788 finding 1).
 *
 * Once this browser has seen a group's chat locked (lib/group-chat-lock-store.ts), the node's word for that conversation
 * no longer decides how a line leaves: a node that now calls it a DM would have the next line sealed to a "peer" it
 * chose, and one that calls it an event's or an enterprise's chat would have it sent readable. So such a conversation is
 * held as a group chat here, sealed or refused, whatever type the node gives it; it is never remembered as a DM.
 * The lock store unreadable is never "never held": a line then leaves by the DM path only for a conversation the DM guard
 * already knows as a DM, and by no readable path at all; and nothing is remembered as a DM on the node's word while it
 * can't be read (review of #1816, finding 3: "A store error remembers nothing", as #1815 does on the phone). Group ids
 * are compared in lower case, as the phone does (finding 9). The phone does the same (apps/native/utils/db.ts,
 * isHeldGroupChat and sealForGroupConversation).
 */
import { heldConversation, isKnownDmConversation } from './dm-guard';
import { lockedGroupsOf } from './group-chat-lock-store';
import { groupsSeenLockedInMemory } from './group-chat-keys';

/** A group id as this app compares it: lower case (a UUID in capitals is the same group). */
export const groupIdKey = (id: string): string => (typeof id === 'string' ? id.toLowerCase() : id);

/** Said when the lock store can't be read and the line would have left by a DM's or a readable chat's path. */
export const GROUP_HOLD_UNREAD_TEXT = "This browser couldn't check its record of locked group chats just now. Nothing was sent; try again in a moment.";
/** Said when a chat opened by its id can't be checked against that record: nothing opens on a guess. */
export const GROUP_HOLD_UNREAD_OPEN_TEXT = "This browser couldn't check its record of locked group chats just now, so this chat didn't open. Try again in a moment.";
/** Said in an event's chat when its id is a group this browser holds locked: that chat sends readable, so nothing goes. */
export const GROUP_HOLD_EVENT_TEXT = "This is a locked group chat, and this screen can't lock messages. Nothing was sent; open it from Messages.";
/** Said when a chat the node calls a group's turns out to be a DM (the DM guard): nothing left; it reopens as the DM. */
export const GROUP_CHAT_IS_DM_TEXT = "This chat holds private messages, so it stays a direct message. Nothing was sent; send it again here.";

/**
 * The groups this identity holds locked here: the store's, and those this page's keyrings have seen locked (a store that
 * reads but couldn't write, or a write torn between its rows, still holds them; finding 4). Null when the store can't
 * be read (then nothing is "never held").
 */
export async function lockedGroupsOrNull(identityPub: string): Promise<ReadonlySet<string> | null> {
    let stored: Set<string>;
    try {
        stored = await lockedGroupsOf(identityPub);
    } catch {
        return null;
    }
    const held = new Set<string>();
    for (const g of stored) held.add(groupIdKey(g));
    for (const g of groupsSeenLockedInMemory(identityPub)) held.add(groupIdKey(g));
    return held;
}

/**
 * The conversation as this app keeps it: a group held locked here is a group chat whatever the node calls it (logged);
 * anything else goes through the DM guard (lib/dm-guard.ts), untouched, its line check included (`lines`: a group
 * chat answer's lines too, before the group route takes it; finding 1). With the lock store unreadable (`null`) the
 * DM guard still keeps a DM it knows, or one whose lines are encrypted, but learns nothing from the node: a node-typed
 * DM is not remembered, so its lines can't leave by sendRouteOf (finding 3).
 */
export function holdConversation<T extends { id: string; type: string }>(
    conv: T, lockedGroups: ReadonlySet<string> | null, lines?: ReadonlyArray<{ nonce?: string | null }>,
): T {
    if (conv?.id && lockedGroups?.has(groupIdKey(conv.id))) {
        if (conv.type === 'group_thread') return conv;
        console.warn(`[group hold] the node calls locked group ${conv.id.slice(0, 8)} a ${conv.type}: ignored, it stays a group chat`);
        return { ...conv, type: 'group_thread' as T['type'] };
    }
    if (lockedGroups === null && conv?.id) {
        if (conv.type !== 'dm' && isKnownDmConversation(conv.id, lines)) {
            console.warn(`[DM guard] the node calls DM ${conv.id.slice(0, 8)} a ${conv.type}: ignored, it stays a DM`);
            return { ...conv, type: 'dm' as T['type'] };
        }
        return conv;
    }
    return heldConversation(conv, lines);
}

/**
 * How a line may leave a conversation the node doesn't call a group chat, read from the lock store at send time:
 * `group` (held locked here: sealed as a group's line, or refused), `as-typed` (never held: the DM or readable path as
 * before), or `refuse` (the store unreadable and not a DM this browser knows: nothing goes).
 */
export async function sendRouteOf(identityPub: string, conversationId: string): Promise<'group' | 'as-typed' | 'refuse'> {
    const locked = await lockedGroupsOrNull(identityPub);
    if (locked === null) {
        if (groupsSeenLockedInMemory(identityPub).some((g) => groupIdKey(g) === groupIdKey(conversationId))) return 'group';
        return isKnownDmConversation(conversationId) ? 'as-typed' : 'refuse';
    }
    return locked.has(groupIdKey(conversationId)) ? 'group' : 'as-typed';
}
