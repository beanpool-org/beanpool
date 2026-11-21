/**
 * Message anyone, on the phone (slice S5 part 2: scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Which path a
 * new chat takes", §6 row S5; Marty 19 Nov 2026, "yes to all 5"). Message on a contact or a New message result goes where
 * core's one rule says (@beanpool/core message-path.ts messagePathFor): an existing chat with that person wins, else the
 * community the phone shares with them (the one it is set to first), else a chat across, made from the contact's link.
 * Nothing switches, and no question is asked.
 *
 * The chats it weighs are read where they live: the community in use's direct chats (db.ts getConversations), each other
 * held community's direct chats through S1's read-only handles (getHeldConversations), and the across chats kept in each
 * file (the store in use, getHeldOutsideChats). A read that fails counts as no chat there: the next rule then decides.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { messagePathFor, type KnownChat, type MessageLink, type MessagePath } from '@beanpool/core';
import { sameCommunity } from './push-pins';

/** Every chat this phone has with any of `keys`: direct ones in the community in use and in `held`, across ones in any of their files. */
export async function knownChatsWith(me: string, keys: readonly string[], held: readonly string[]): Promise<KnownChat[]> {
    const want = new Set(keys);
    const out: KnownChat[] = [];
    const db = await import('./db');
    const anchor = await anchorUrl();
    const isDirect = (type: unknown) => type === null || type === undefined || type === 'dm';
    const peersOf = (one: unknown, many: unknown) => [...new Set([...(typeof many === 'string' && many ? many.split(',') : Array.isArray(many) ? many : []), ...(typeof one === 'string' && one ? [one] : [])])];
    if (anchor) {
        for (const c of await db.getConversations(me).catch(() => [] as any[])) {
            if (!isDirect(c?.convType)) continue;
            for (const key of peersOf(c.otherPubkey, c.otherKeys)) if (want.has(key)) out.push({ kind: 'direct', community: anchor, id: String(c.id), key });
        }
    }
    for (const community of held) {
        for (const c of (await db.getHeldConversations(me, community).catch(() => null)) ?? []) {
            if (!isDirect(c.type)) continue;
            for (const key of peersOf(c.peerPubkey, c.peerKeys)) if (want.has(key)) out.push({ kind: 'direct', community, id: c.id, key });
        }
    }
    const { outsideContext } = await import('./outside-chat-live');
    const ctx = await outsideContext().catch(() => null);
    for (const c of (ctx ? await ctx.store.chats(me).catch(() => []) : [])) if (want.has(c.peerKey)) out.push({ kind: 'across', community: null, id: c.id, key: c.peerKey });
    for (const community of held) {
        for (const c of (await db.getHeldOutsideChats(me, community).catch(() => null)) ?? []) if (want.has(c.peerKey)) out.push({ kind: 'across', community, id: c.id, key: c.peerKey });
    }
    return out;
}

/**
 * Where Message on a person goes from this phone ({@link knownChatsWith}, then core's rule). `held`: the other communities it
 * holds as a member (never a guest's look), in the order it lists them.
 */
export async function messagePathOnPhone(me: string, links: readonly MessageLink[], held: readonly string[]): Promise<MessagePath> {
    const setTo = await anchorUrl();
    const others = held.filter((h) => !setTo || !sameCommunity(h, setTo));
    const chats = links.length ? await knownChatsWith(me, links.map((l) => l.key), others) : [];
    return messagePathFor({ links, chats, setTo, held: others, same: sameCommunity });
}

/** What became of an across chat asked for: opened (its id), or why not. */
export type AcrossOpened = { chatId: string } | { refused: 'no-community' | 'off' | 'blocked' };

/**
 * A chat across with someone in a community the phone shares none with, made from the contact's link as an address card
 * makes one (outside-mail.ts openChatFromCard: kept in the community in use's file, open, named as the link names them).
 * Refused with no community in use, where the community in use doesn't take messages from other communities, or for someone
 * the account blocked; nothing is made then.
 */
export async function openAcrossChat(target: { key: string; home: string; name: string | null }): Promise<AcrossOpened> {
    const live = await import('./outside-chat-live');
    const ctx = await live.outsideContext().catch(() => null);
    if (!ctx) return { refused: 'no-community' };
    if (!(await live.outsideMessagesHere(ctx.nodeUrl).catch(() => false))) return { refused: 'off' };
    const { openChatFromCard } = await import('./outside-mail');
    const chatId = await openChatFromCard(ctx, target);
    return chatId ? { chatId } : { refused: 'blocked' };
}

/**
 * A direct chat with `key` started in `community`, another community this phone holds, in place (slice S2): by the address
 * the phone saved for it, however the link spells it, held in place while it starts (db.ts enterChatInPlace ... leaveChatInPlace).
 * Throws db.ts's refusals as they come (isNoCopyInPlace: that copy can't be opened in place now).
 */
export async function startChatInPlace(me: string, key: string, community: string): Promise<{ id: string; community: string }> {
    const db = await import('./db');
    const { getSavedNodes } = await import('./nodes');
    const saved = (await getSavedNodes().catch(() => [])).find((n) => sameCommunity(n.url, community))?.url ?? community;
    db.enterChatInPlace(saved);
    try {
        const conv = await db.createConversationApi('dm', [me, key], me, undefined, undefined, saved);
        return { id: String(conv.id), community: saved };
    } finally {
        void db.leaveChatInPlace(saved);
    }
}

/** The chat route Message pushes for a chat that exists: here, in place in a held community (slice S2), or across (slice S4). */
export function existingChatRoute(chat: KnownChat, setTo: string | null, nameOf: (community: string) => string):
    string | { pathname: '/chat/[id]'; params: { id: string; community: string; communityName: string } } {
    if (chat.kind === 'across') return chat.community ? `/outside-chat/${chat.id}?community=${encodeURIComponent(chat.community)}` : `/outside-chat/${chat.id}`;
    if (setTo && sameCommunity(chat.community, setTo)) return `/chat/${chat.id}`;
    return { pathname: '/chat/[id]', params: { id: chat.id, community: chat.community, communityName: nameOf(chat.community) } };
}

async function anchorUrl(): Promise<string | null> {
    return (await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null)) || null;
}
