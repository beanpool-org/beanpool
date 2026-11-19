/**
 * Chat's rows from every other community this phone holds (slice S1, scratch/fable-design/DESIGN-no-switch-messaging-fable.md
 * §1 and §6): Damo, 19 Nov 2026, "if I switch to another node it's gone". Each community's chats are read from that
 * community's own copy through a held, read-only handle (utils/db.ts getHeldConversations, utils/held-copies.ts), by its
 * name, never through the copy in use. A tap still moves the phone there and opens the chat (app/(tabs)/chats.tsx):
 * reading and replying in place is slice S2.
 *
 * Which communities: the phone's saved list, one row set per community however its address is spelled, never the one in
 * use, never one visited as a guest (its copy holds no chat of the member's), never an address that isn't plain. A
 * community whose copy hasn't synced (or was cleared) since shows nothing (getHeldConversations).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { closeHeldCopies, getHeldConversations, getHeldOutsideChats, heldChatIsDm, type HeldConversation } from './db';
import { getDatabaseFilenameForNode, getSavedNodes, isGuestCopy, isGuestNode } from './nodes';
import { isPlainNodeAddress } from './node-url';
import { sameCommunity } from './push-pins';
import { communityName } from './community-name';
import { getBlockedUsers, isUserBlocked } from './blocklist';
import { talkShowsChat } from './dm-blocked';
import type { OutsideChat } from './outside-chat-store';

export interface HeldChatRow extends HeldConversation {
    /** The row's key in Chat's list: never that of a chat in the community in use, nor of the same id in another. */
    key: string;
    held: true;
    /** The community's address, as the saved list has it: where a tap moves the phone. */
    community: string;
    /** Its name as the phone saved it, in grey under the person's. */
    communityName: string;
}

export { heldChatInPlaceParams, heldChatOpensInPlace } from './held-chat-in-place';

/** One stretch of Chat in view (its focus effect), as {@link heldChatsInView} hands it out. */
export interface HeldChatsView {
    /** True until Chat is left. */
    inView(): boolean;
    /** Chat is left: every held handle closes, unless Chat is in view again by then. Once only. */
    leave(): Promise<void>;
}

/** How many stretches of Chat are in view now: one, but a quick move away and back can have the next begin first. */
let viewsInView = 0;

/** Close every held handle, unless Chat is in view again: the handles are Chat's, and only Chat reads them (slice S1). */
function closeUnlessInView(): Promise<void> {
    return viewsInView === 0 ? closeHeldCopies() : Promise.resolve();
}

/**
 * Chat in view, from its focus to its blur (app/(tabs)/chats.tsx): its held reads go through it, so no handle opened after
 * Chat is left stays open (#3302 review F3). As Chat is left (`leave`) every held handle closes; a list still on its way
 * then reads no community more ({@link heldChatRows}) and closes once more as it ends, for a handle it opened after that
 * close. Neither close runs while Chat is in view again.
 */
export function heldChatsInView(): HeldChatsView {
    viewsInView++;
    let shown = true;
    return {
        inView: () => shown,
        leave: () => {
            if (!shown) return Promise.resolve();
            shown = false;
            viewsInView--;
            return closeUnlessInView();
        },
    };
}

/**
 * The held rows Chat lists: {@link heldChatRows} less every DM with someone the member blocked, under any key that chat
 * names them by in its own community, its pin's former and offered keys included (db.ts getHeldConversations peerKeys), as
 * Talk's own list leaves them out (dm-blocked.ts talkShowsChat).
 */
export async function heldChatsShown(myPubkey: string, view?: HeldChatsView): Promise<HeldChatRow[]> {
    const [blocked, rows] = await Promise.all([getBlockedUsers(), heldChatRows(myPubkey, view)]);
    return rows.filter((c) => talkShowsChat(c, blocked));
}

/**
 * Chat's held rows. `view`: Chat in view ({@link heldChatsInView}); once it is left, no further community is read, and
 * what this list opened closes as it ends (unless Chat is in view again).
 */
export async function heldChatRows(myPubkey: string, view?: HeldChatsView): Promise<HeldChatRow[]> {
    try {
        return await heldChatRowsWhile(myPubkey, view ? view.inView : () => true);
    } finally {
        if (view && !view.inView()) await closeUnlessInView();
    }
}

/**
 * The other communities whose copies Chat reads (slice S1; S4's across chats too): the saved list, one per file however its
 * address is spelled, never the one in use, never a guest's look, never an address that isn't plain; each with its saved name.
 */
async function heldCommunities(): Promise<Array<{ url: string; file: string; name: string }>> {
    const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
    const out: Array<{ url: string; file: string; name: string }> = [];
    const files = new Set<string>();
    for (const node of await getSavedNodes()) {
        const url = node.url;
        if (!isPlainNodeAddress(url) || (anchor && sameCommunity(url, anchor))) continue;
        if (await isGuestNode(url).catch(() => true)) continue;
        const file = getDatabaseFilenameForNode(url);
        if (files.has(file)) continue;
        files.add(file);
        const savedName = (node as { name?: unknown }).name;
        out.push({ url, file, name: typeof savedName === 'string' && savedName.trim() ? savedName.trim() : communityName(node) });
    }
    return out;
}

async function heldChatRowsWhile(myPubkey: string, inView: () => boolean): Promise<HeldChatRow[]> {
    const rows: HeldChatRow[] = [];
    for (const { url, file, name } of await heldCommunities()) {
        // Chat left: no further community's copy is opened (one opened since the close as it was left closes as this ends).
        if (!inView()) break;
        const chats = await getHeldConversations(myPubkey, url);
        if (!chats) continue;
        for (const chat of chats) rows.push({ ...chat, key: `held:${file}:${chat.id}`, held: true, community: url, communityName: name });
    }
    return rows;
}

/**
 * A chat with someone in a community the member doesn't belong to, kept in the file of another community this phone holds
 * (slice S4, scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3: "Same file, same rule, visible always"). It opens
 * in that file (app/outside-chat/[id].tsx `community`): read, answered and fetched there with no switch.
 */
export interface HeldOutsideChat extends OutsideChat {
    /** The row's key in Chat's list and the requests list: never that of an across chat in use, nor of the same id elsewhere. */
    key: string;
    /** The community whose file carries it, as the saved list has its address: where its mail is fetched and its lines go. */
    community: string;
    communityName: string;
}

/**
 * Where an across chat opens (app/outside-chat/[id].tsx): in the file that carries it, named by its community when that is
 * another one this phone holds (slice S4), else the community in use's, as before.
 */
export function outsideChatHref(chat: { id: string; community?: string }): string {
    return chat.community ? `/outside-chat/${chat.id}?community=${encodeURIComponent(chat.community)}` : `/outside-chat/${chat.id}`;
}

/**
 * The across chats and requests kept in every other community's file this phone holds, read through held, read-only handles
 * (db.ts getHeldOutsideChats), none with someone the account blocked (as outside-mail.ts chatsShown leaves them out). `view`:
 * as {@link heldChatRows}, so no handle opened after Chat is left stays open.
 */
export async function heldOutsideChatsShown(myPubkey: string, view?: HeldChatsView): Promise<HeldOutsideChat[]> {
    const inView = view ? view.inView : () => true;
    try {
        const out: HeldOutsideChat[] = [];
        for (const { url, file, name } of await heldCommunities()) {
            if (!inView()) break;
            for (const chat of (await getHeldOutsideChats(myPubkey, url)) ?? []) {
                if (await isUserBlocked(chat.peerKey)) continue;
                out.push({ ...chat, key: `held-across:${file}:${chat.id}`, community: url, communityName: name });
            }
        }
        return out;
    } finally {
        if (view && !view.inView()) await closeUnlessInView();
    }
}

/**
 * What a link to a chat of another community opens (slice S2; #3305 review F1 and F2). The chat's route asks this before
 * it draws anything for a `community` param:
 * - `here`: the community in use, however spelled: the chat's ordinary route, which asks what kind of chat the id is;
 * - `in-place`: a direct chat that community's own copy already holds (db.ts heldChatIsDm, read only), at the address and
 *   under the name the phone saved for it, never a link's own;
 * - `move`: any other id of a community this phone holds as a member (a group's, an event's or an enterprise's chat, an
 *   id its copy doesn't hold): nothing of it opens in place, and a tap moves the phone there (S1);
 * - `nothing`: not a community this phone holds (not saved, a guest's look, not a plain address).
 */
export type ChatInPlaceRoute =
    | { open: 'here' }
    | { open: 'in-place' | 'move'; community: string; name: string }
    | { open: 'nothing' };

export async function chatInPlaceRoute(myPubkey: string | null | undefined, id: string, community: string): Promise<ChatInPlaceRoute> {
    const file = getDatabaseFilenameForNode(community);
    if (getDatabaseFilenameForNode(await AsyncStorage.getItem('beanpool_anchor_url')) === file) return { open: 'here' };
    const node = (await getSavedNodes().catch(() => [])).find((n) => getDatabaseFilenameForNode(n.url) === file);
    if (!node || !isPlainNodeAddress(node.url) || await isGuestCopy(node.url).catch(() => true)) return { open: 'nothing' };
    // Named as Chat's held rows name it: the name the phone saved, else the community's own.
    const savedName = (node as { name?: unknown }).name;
    const where = { community: node.url, name: typeof savedName === 'string' && savedName.trim() ? savedName.trim() : communityName(node) };
    if (!myPubkey || !id) return { open: 'move', ...where };
    try {
        return (await heldChatIsDm(myPubkey, node.url, id)) ? { open: 'in-place', ...where } : { open: 'move', ...where };
    } finally {
        // The check read through a held, read-only handle: it closes again unless Chat is in view (#3302 review F3). The
        // chat doesn't wait for that close: the copy it opens in place is a connection of its own.
        void closeUnlessInView().catch(() => {});
    }
}
