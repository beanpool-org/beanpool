/**
 * A group stays a group (group chats slice 4; director's decision b, confirmation of #1788 finding 1).
 *
 * Once this browser has seen a group's chat locked (lib/group-chat-lock-store.ts), the node's word for that conversation
 * no longer decides how a line leaves: a node that now calls it a DM would have the next line sealed to a "peer" it
 * chose, and one that calls it an event's or an enterprise's chat would have it sent readable. So such a conversation is
 * held as a group chat here, sealed or refused, whatever type the node gives it; it is never remembered as a DM.
 * The lock store unreadable is never "never held": a line then leaves by the DM path only for a conversation the DM guard
 * already knows as a DM, and by no readable path at all. The phone does the same (apps/native/utils/db.ts,
 * isHeldGroupChat and sealForGroupConversation).
 */
import { heldConversation, isKnownDmConversation } from './dm-guard';
import { lockedGroupsOf } from './group-chat-lock-store';

/** Said when the lock store can't be read and the line would have left by a DM's or a readable chat's path. */
export const GROUP_HOLD_UNREAD_TEXT = "This browser couldn't check its record of locked group chats just now. Nothing was sent; try again in a moment.";

/** The groups this identity holds locked here, or null when the store can't be read (then nothing is "never held"). */
export async function lockedGroupsOrNull(identityPub: string): Promise<ReadonlySet<string> | null> {
    try {
        return await lockedGroupsOf(identityPub);
    } catch {
        return null;
    }
}

/**
 * The conversation as this app keeps it: a group held locked here is a group chat whatever the node calls it (logged);
 * anything else goes through the DM guard (lib/dm-guard.ts), untouched.
 */
export function holdConversation<T extends { id: string; type: string }>(
    conv: T, lockedGroups: ReadonlySet<string> | null, lines?: ReadonlyArray<{ nonce?: string | null }>,
): T {
    if (conv?.id && lockedGroups?.has(conv.id)) {
        if (conv.type === 'group_thread') return conv;
        console.warn(`[group hold] the node calls locked group ${conv.id.slice(0, 8)} a ${conv.type}: ignored, it stays a group chat`);
        return { ...conv, type: 'group_thread' as T['type'] };
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
    if (locked === null) return isKnownDmConversation(conversationId) ? 'as-typed' : 'refuse';
    return locked.has(conversationId) ? 'group' : 'as-typed';
}
