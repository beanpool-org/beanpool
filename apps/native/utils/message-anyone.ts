/**
 * Message anyone, on the phone (slice S5 part 2: scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Which path a
 * new chat takes", §6 row S5; Marty 19 Nov 2026, "yes to all 5"). Message on a contact or a New message result goes where
 * core's one rule says (@beanpool/core message-path.ts messagePathFor): an existing chat with that person wins, else the
 * community the phone shares with them (the one it is set to first), else a chat across, made from the contact's link.
 * Nothing switches, and no question is asked.
 *
 * The chats it weighs are the ones Chat lists, read by Chat's own readers (#3354 review): the community in use's direct chats
 * (db.ts getConversations, less any Talk hides: dm-blocked.ts talkShowsChat), each other held community's direct and across
 * chats (held-chats.ts heldChatsWith), and the across chats in the community in use's file (outside-mail.ts chatsShown), an
 * across chat only while Chat lists it, open or a request (core acrossChatListed). So nothing a block hid is reopened, and a
 * chat across the member declined (no composer, no Accept) is no existing chat: the community shared opens, or across
 * reopens it as an address card does. A read that fails counts as no chat there: the next rule then decides.
 *
 * Nothing it opens or makes is a chat the member can't write in now (#3354 review round 4, the rule's own invariant), and no
 * message goes to no one: a chat across counts only where its community takes messages from other communities and has an
 * address of its own to send from (by its info as this phone keeps it: {@link acrossRefusal}), and its person is in no
 * community the phone shares with them, by any of its addresses (utils/community-homes.ts: never a name it lost).
 *
 * On a guest's look (the phone set to a community it only visits as a guest, nodes.ts isGuestCopy) there is no community in
 * use (core's `setTo` null): nothing there is shared, and no chat across is weighed or made in its copy ({@link
 * openAcrossChat}). A direct chat the member already has there opens (a visitor's own row may write in it: core's `look`).
 *
 * A block is asked first, on every path ({@link blockedForMessage}): someone blocked on this phone's own list (the list
 * Chat reads; Marty 22 Nov, the S7 rule) is refused, with the words the across path already said, and nothing opens or is made.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { acrossChatListed, communityNamed, messagePathFor, type KnownChat, type MessageLink, type MessagePath } from '@beanpool/core';
import type { getConversations } from './db';
import { addressesFor, keptAsOne, keptProfileOf, namesCommunityInUse, reachedAt } from './community-homes';
import { communityRecordOf } from './community-index';
import type { NodeProfile } from './node-profile';
import { sameCommunity } from './push-pins';

/** A chat of the community in use as Chat's list has it (db.ts getConversations): the fields Message reads. */
export type HereChat = Pick<Awaited<ReturnType<typeof getConversations>>[number], 'id' | 'type' | 'peerPubkey' | 'peerKeys'>;

/** The direct chats here with any of `keys`, from what Chat lists (`chats`, as getConversations returns them, less any `shows` hides). */
export function directChatsHere(chats: readonly HereChat[], keys: readonly string[], community: string, shows: (c: HereChat) => boolean): KnownChat[] {
    const want = new Set(keys);
    const out: KnownChat[] = [];
    for (const c of chats) {
        if (c.type !== 'dm' || !shows(c)) continue;
        // Every key Talk knows them by here (dm-blocked.ts talkShowsChat reads the same two fields).
        const theirs = new Set([...(Array.isArray(c.peerKeys) ? c.peerKeys : []), ...(c.peerPubkey ? [c.peerPubkey] : [])]);
        for (const key of theirs) if (want.has(key)) out.push({ kind: 'direct', community, id: String(c.id), key });
    }
    return out;
}

/**
 * Every chat Chat lists with any of `keys`: direct ones in the copy in use (`inFront`, the community the phone is set to, a
 * guest's look too) and in the other held communities, across ones in any of their files while Chat lists them (open or a
 * request; in the copy in use only as its `member`). Each source is read on its own: one that fails counts as no chat there,
 * and the others still count.
 */
export async function knownChatsWith(me: string, keys: readonly string[], { inFront, member }: { inFront: string | null; member: boolean }): Promise<KnownChat[]> {
    const want = new Set(keys);
    const directHere = async (): Promise<KnownChat[]> => {
        if (!inFront) return [];
        const db = await import('./db');
        const { talkShowsChat } = await import('./dm-blocked');
        const { getBlockedUsers } = await import('./blocklist');
        const [here, blocked] = await Promise.all([db.getConversations(me), getBlockedUsers()]);
        return directChatsHere(here, keys, inFront, (c) => talkShowsChat(c, blocked));
    };
    const held = async (): Promise<KnownChat[]> => (await import('./held-chats')).heldChatsWith(me, keys);
    const acrossHere = async (): Promise<KnownChat[]> => {
        if (!member) return [];
        const { outsideContext } = await import('./outside-chat-live');
        const { chatsShown } = await import('./outside-mail');
        const ctx = await outsideContext();
        return ctx ? (await chatsShown(ctx)).filter((c) => want.has(c.peerKey) && acrossChatListed(c.state))
            .map((c) => ({ kind: 'across' as const, community: null, id: c.id, key: c.peerKey, home: c.peerHome })) : [];
    };
    const none = (): KnownChat[] => [];
    return [...await directHere().catch(none), ...await held().catch(none), ...await acrossHere().catch(none)];
}

/**
 * Whether Message refuses this person (#3354 review), by any key `links` names them by: blocked on this phone's own list
 * (the list Chat, the across list, the address card and Contacts read). A block seen only on another community's own list
 * (a block made in that community's web app) does not refuse it: Marty, 22 Nov, keeping his S7 answer to question 2 (such a
 * block stops the quiet Accept and hides the request card, nothing more), so Message and Chats never disagree. Someone
 * blocked once and unblocked since is not refused either (only a quiet let in asks `once`). Null when the lists can't be
 * read: nothing opens on a guess.
 */
export async function blockedForMessage(me: string, keys: readonly string[]): Promise<boolean | null> {
    const { readBlockLists } = await import('./blocklist');
    const lists = await readBlockLists(me).catch(() => null);
    return lists ? keys.some((k) => lists.onPhone.has(k)) : null;
}

/**
 * Where Message on a person goes from this phone: the block first ({@link blockedForMessage}), then core's rule over the
 * chats Chat lists ({@link knownChatsWith}). `held`: the other communities it holds as a member, in the order it lists
 * them (a guest's look among them is left out, and the community in use under another of its addresses). On a guest's look
 * the community in use is none (core's `setTo` null, the look its `look`). `nothing` too when the block lists can't be read.
 */
export async function messagePathOnPhone(me: string, links: readonly MessageLink[], held: readonly string[]): Promise<MessagePath> {
    const inFront = await anchorUrl();
    const look = inFront && await guestLook(inFront) ? inFront : null;
    const setTo = look ? null : inFront;
    const others: string[] = [];
    for (const h of held) {
        if (await guestLook(h)) continue;
        if (![...(inFront ? [inFront] : []), ...others].some((c) => keptAsOne(c, h))) others.push(h);
    }
    const keys = links.map((l) => l.key);
    const blocked = keys.length ? await blockedForMessage(me, keys) : false;
    if (blocked === null) return { open: 'nothing' };
    const chats = keys.length && !blocked ? await knownChatsWith(me, keys, { inFront, member: setTo !== null }) : [];
    const says = new Map<string, NodeProfile | null>();
    for (const c of [...(inFront ? [inFront] : []), ...others]) says.set(c, await keptProfileOf(c));
    const { outsideMessagesOn } = await import('./node-profile');
    const named = [...links.map((l) => l.community), ...chats.map((c) => (c.kind === 'across' ? c.home : null))];
    const pathBySays = async (): Promise<MessagePath> => {
        const communities = [];
        // One after another: each held read closes the handles Chat doesn't need (held-chats.ts).
        for (const [c, profile] of says) communities.push(await addressesFor(c, profile, c === inFront, keys, named));
        return messagePathFor({
            links, chats, setTo, look, held: others, blocked,
            whose: communityNamed(communities),
            // Not heard from yet: its chats across still count (only a community that says it takes none is left out).
            takesAcross: (c) => { const profile = says.get(c); return !profile || acrossRefusal(profile, outsideMessagesOn) === null; },
        });
    };
    // A chat to start where the link's address is the community's only by its own word: its word is asked now ({@link
    // openAcrossChat} asks as a chat across is made), since a name it lost after this phone last heard is another's, and the
    // chat would reach no one. No answer, or one that says nothing of its addresses: as this phone keeps it.
    const asked = new Set<string>();
    for (;;) {
        const path = await pathBySays();
        if (path.open !== 'shared' || asked.has(path.community) || links.some((l) => l.key === path.key && reachedAt(path.community, l.community))) return path;
        asked.add(path.community);
        const { profileNow } = await import('./outside-chat-live');
        const fresh = await profileNow(communityRecordOf(path.community)?.using ?? path.community).catch(() => null);
        if (!fresh?.addresses) return path;
        says.set(path.community, fresh);
    }
}

/**
 * Why a community takes no messages across, by its info, or null: its switch is off (not heard from: taken as off), or it
 * says it has no address of its own (core saysNoHome: its server answers every send 503, so a line would stay "Sending…").
 */
function acrossRefusal(profile: NodeProfile | null, on: (features: NodeProfile['features'] | undefined) => boolean): 'off' | 'no-home' | null {
    return !on(profile?.features) ? 'off' : profile?.noHome ? 'no-home' : null;
}

/** What became of an across chat asked for: opened (its id); the person is in the community in use after all (`here`, their key); or why not. */
export type AcrossOpened = { chatId: string } | { here: string } | { refused: 'no-community' | 'off' | 'no-home' | 'blocked' };

/**
 * A chat across with someone in a community the phone shares none with, made from the contact's link as an address card
 * makes one (outside-mail.ts openChatFromCard: kept in the community in use's file, open, named as the link names them; a
 * declined one there is opened again, and one kept with another home goes to the link's now). Refused with no community in
 * use (a guest's look included: its copy is not the member's, and its server would refuse the line), where the community
 * in use doesn't take messages from other communities or has no address of its own to send from, or for someone the account
 * blocked; nothing is made then. Nor when the link's address is one of the community in use's own (its info asked now:
 * outside-chat-live.ts profileNow), where the direct chat here is theirs: its server refuses every line across to one of
 * its own names.
 */
export async function openAcrossChat(target: { key: string; home: string; name: string | null }): Promise<AcrossOpened> {
    const inFront = await anchorUrl();
    if (!inFront || await guestLook(inFront)) return { refused: 'no-community' };
    const live = await import('./outside-chat-live');
    const ctx = await live.outsideContext().catch(() => null);
    if (!ctx) return { refused: 'no-community' };
    const profile = await live.profileNow(ctx.nodeUrl).catch(() => null);
    const { outsideMessagesOn } = await import('./node-profile');
    if (await namesCommunityInUse(ctx.nodeUrl, target.home, target.key, profile)) return { here: target.key };
    const refused = acrossRefusal(profile, outsideMessagesOn);
    if (refused) return { refused };
    const { openChatFromCard } = await import('./outside-mail');
    const chatId = await openChatFromCard(ctx, { key: target.key, home: target.home, name: target.name });
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

/**
 * The chat route Message pushes for a chat that exists: here (`inFront`: the community the phone is set to, a guest's look
 * too), in place in a held community (slice S2), or across (slice S4).
 */
export function existingChatRoute(chat: KnownChat, inFront: string | null, nameOf: (community: string) => string):
    string | { pathname: '/chat/[id]'; params: { id: string; community: string; communityName: string } } {
    if (chat.kind === 'across') return chat.community ? `/outside-chat/${chat.id}?community=${encodeURIComponent(chat.community)}` : `/outside-chat/${chat.id}`;
    if (inFront && keptAsOne(inFront, chat.community)) return `/chat/${chat.id}`;
    return { pathname: '/chat/[id]', params: { id: chat.id, community: chat.community, communityName: nameOf(chat.community) } };
}

/** The community the phone is set to, as a member or as a guest's look: its address, or null. */
export async function anchorUrl(): Promise<string | null> {
    return (await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null)) || null;
}

/** Whether `community` is a guest's look on this phone, however spelled (nodes.ts isGuestCopy). A mark that can't be read counts as one: nothing is weighed or made on a guess. */
async function guestLook(community: string): Promise<boolean> {
    const { isGuestCopy } = await import('./nodes');
    return isGuestCopy(community).catch(() => true);
}
