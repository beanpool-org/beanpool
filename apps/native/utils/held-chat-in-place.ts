/**
 * Which of Chat's held rows open in place (slice S2, scratch/fable-design/DESIGN-no-switch-messaging-fable.md §6): a direct
 * chat only, read and answered in its own community with no switch (app/chat/[id].tsx, `community` param). A group's, a
 * deal's or an event's chat in place is slice S6; until then a tap on one moves the phone there (S1). Kept apart from
 * utils/held-chats.ts, which reads the copies: the row (components/HeldChatRow.tsx) asks this and nothing else.
 */

/** Whether a tap on this held row opens its chat in place, with no switch: a direct chat only. */
export function heldChatOpensInPlace(chat: { type?: string | null }): boolean {
    return (chat.type || 'dm') === 'dm';
}

/** The chat screen's params for a held direct chat opened in place: its id, its community by address, and that community's name. */
export function heldChatInPlaceParams(chat: { id: string; community: string; communityName: string }): { id: string; community: string; communityName: string } {
    return { id: chat.id, community: chat.community, communityName: chat.communityName };
}
