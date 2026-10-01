/**
 * A line whose author deleted their account. The node blanks every line they wrote, in every kind of chat, and marks
 * each with `metadata.accountDeleted` (apps/server/src/engine/message-tombstone.ts). It is the author's own delete, so in
 * an event or an enterprise chat it must not read as the host's or a keeper's removal, as every other tombstone there does.
 */

/** What such a line reads as: the node's ACCOUNT_DELETED_TEXT, the words a DM or a group chat already uses. */
export const ACCOUNT_DELETED_TEXT = 'This message was deleted';

/** True for a tombstone the node wrote when its author deleted their account. Never throws. */
export function blankedWithAccount(metadata: string | null | undefined): boolean {
    if (!metadata) return false;
    try {
        return JSON.parse(metadata)?.accountDeleted === true;
    } catch {
        return false;
    }
}
