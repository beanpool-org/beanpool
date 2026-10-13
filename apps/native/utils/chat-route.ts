/**
 * chat-route — which screen `/chat/:id` draws (app/chat/[id].tsx ChatRoute), as a pure function of what the phone has
 * learned about the conversation, so the order can be tested (confirmation 2 of #1788, findings 2 and 4).
 *
 * The order:
 * 1. A group whose keys this phone has held opens only in its group chat (sealed or refused), whatever a link, the
 *    local row or the node says, a DM label included (director's decision b; confirmation 2, finding 2).
 * 2. A known DM opens only in the DM screen (the DM guard). A known DM is never held: no group keys are synced for it.
 * 3. When the key memory couldn't be read, nothing opens that posts without asking it: the DM screen and a group's chat
 *    both ask it again on every send and refuse; the event chat and the enterprise thread don't, so they never open then.
 * 4. Otherwise an event chat, a group's or an enterprise's thread, by the link or the conversation's type.
 * 5. Everything else is a DM.
 */

export type ChatRouteView = 'wait' | 'group' | 'dm' | 'event' | 'group_thread' | 'enterprise_thread';

export interface ChatRouteFacts {
    /** isHeldGroupChat: null while asking, 'error' when this phone couldn't read its key memory. */
    held: boolean | null | 'error';
    /** isKnownDmConversation: null while asking. */
    knownDm: boolean | null;
    /** A link said `event=1`, or the conversation's type is an event chat. */
    isEventChat: boolean;
    /** A link said `group=1` / `enterprise=1`, or the conversation's type says which. */
    threadKind: 'group' | 'enterprise' | null;
}

export function chatRouteView(f: ChatRouteFacts): ChatRouteView {
    if (f.held === null) return 'wait';
    if (f.held === true) return 'group';
    if (f.knownDm === null) return 'wait';
    if (f.knownDm) return 'dm';
    if (f.held === 'error') return f.threadKind === 'group' ? 'group_thread' : 'dm';
    if (f.isEventChat) return 'event';
    if (f.threadKind === 'group') return 'group_thread';
    if (f.threadKind === 'enterprise') return 'enterprise_thread';
    return 'dm';
}
