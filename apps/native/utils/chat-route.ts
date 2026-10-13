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

/** What ChatRoute asks utils/db.ts, passed in so its wiring is tested here (#1815 review, finding 3). */
export interface ChatRouteAsks {
    isHeldGroupChat(id: string): Promise<boolean>;
    /** knownDmConversationId: the spelling this phone keeps a DM under, in any spelling of the id; null when it knows none. */
    knownDmConversationId(id: string): Promise<string | null>;
    getConversationKind(id: string, opts: { askNode?: boolean }): Promise<string | null>;
}

/** The held fact: a key memory that couldn't be read is 'error', never "not held" (confirmation 2 of #1788, finding 1). */
export function askHeldGroup(asks: ChatRouteAsks, id: string): Promise<boolean | 'error'> {
    return asks.isHeldGroupChat(id).then((h) => h, () => 'error' as const);
}

/** The known-DM fact, as the spelling the phone keeps the DM under: null (not a known DM) when it can't be asked. */
export function askKnownDm(asks: ChatRouteAsks, id: string): Promise<string | null> {
    return asks.knownDmConversationId(id).then((k) => (typeof k === 'string' && k ? k : null), () => null);
}

/**
 * The kind the route reads from the conversation's type. With no row yet (a push tap before the sync) the node is asked,
 * so a group's chat opens in its own screen (confirmation 2 of #1788, finding 3).
 */
export async function askRouteKind(asks: ChatRouteAsks, id: string): Promise<'event' | 'group' | 'enterprise' | null> {
    const kind = await asks.getConversationKind(id, { askNode: true });
    if (kind === 'event_thread') return 'event';
    if (kind === 'group_thread') return 'group';
    if (kind === 'enterprise_thread') return 'enterprise';
    return null;
}

/**
 * The id the node-readable screens get. Ids are UUIDs, lower-case as the node makes them; a link or a push may carry one
 * in capitals (push routes match them case-insensitively): the screens get the node's spelling.
 */
export function screenIdOf(id: string): string {
    return id.toLowerCase();
}

/** What the link said on the way in: `event=1`, or `group=1` / `enterprise=1`. */
export interface ChatRouteLink {
    event?: boolean;
    thread?: 'group' | 'enterprise' | null;
}

export interface ChatRoute {
    view: Exclude<ChatRouteView, 'wait'>;
    /** The id the drawn screen gets: a known DM's screen gets the spelling the phone keeps it under, any other DM screen
     *  the link's; the others get screenIdOf. */
    screenId: string;
}

/**
 * Which screen `/chat/:id` draws and the id it gets, from one canonical id (screenIdOf): the held check and the DM guard
 * are asked of it, and a group's screen gets it, so no spelling of an id can be a DM to one check and a group to the next
 * (#1841 review, findings 1 and 4). A known DM is one conversation whatever the link's case: its kind is asked of the
 * spelling the phone keeps it under (so no second row is fetched from the node under another), and its DM screen gets that
 * spelling, so a push in capitals opens the conversation the phone already has (#1841 confirmation 1, C3 and C4).
 * Resolves once every fact is in; never rejects.
 */
export async function routeChat(asks: ChatRouteAsks, id: string, link: ChatRouteLink): Promise<ChatRoute> {
    const canonical = screenIdOf(id);
    const [held, knownDm] = await Promise.all([askHeldGroup(asks, canonical), askKnownDm(asks, id)]);
    const kind = link.event || link.thread ? null : await askRouteKind(asks, knownDm ?? canonical).catch(() => null);
    const view = chatRouteView({
        held, knownDm: knownDm !== null, isEventChat: !!link.event || kind === 'event',
        threadKind: link.thread ?? (kind === 'group' || kind === 'enterprise' ? kind : null),
    }) as ChatRoute['view'];
    return { view, screenId: view === 'dm' ? knownDm ?? id : canonical };
}
