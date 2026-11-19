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
import { closeHeldCopies, getHeldConversations, type HeldConversation } from './db';
import { getDatabaseFilenameForNode, getSavedNodes, isGuestNode } from './nodes';
import { isPlainNodeAddress } from './node-url';
import { sameCommunity } from './push-pins';
import { communityName } from './community-name';
import { getBlockedUsers } from './blocklist';
import { talkShowsChat } from './dm-blocked';

export interface HeldChatRow extends HeldConversation {
    /** The row's key in Chat's list: never that of a chat in the community in use, nor of the same id in another. */
    key: string;
    held: true;
    /** The community's address, as the saved list has it: where a tap moves the phone. */
    community: string;
    /** Its name as the phone saved it, in grey under the person's. */
    communityName: string;
}

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
 * Chat's held rows. `view`: Chat in view ({@link heldChatsInView}); once it is left, no further community is read, and
 * what this list opened closes as it ends (unless Chat is in view again).
 */
/**
 * The held rows Chat lists: {@link heldChatRows} less every DM with someone the member blocked, under any key that chat
 * names them by in its own community, its pin's former and offered keys included (db.ts getHeldConversations peerKeys), as
 * Talk's own list leaves them out (dm-blocked.ts talkShowsChat).
 */
export async function heldChatsShown(myPubkey: string, view?: HeldChatsView): Promise<HeldChatRow[]> {
    const [blocked, rows] = await Promise.all([getBlockedUsers(), heldChatRows(myPubkey, view)]);
    return rows.filter((c) => talkShowsChat(c, blocked));
}

export async function heldChatRows(myPubkey: string, view?: HeldChatsView): Promise<HeldChatRow[]> {
    try {
        return await heldChatRowsWhile(myPubkey, view ? view.inView : () => true);
    } finally {
        if (view && !view.inView()) await closeUnlessInView();
    }
}

async function heldChatRowsWhile(myPubkey: string, inView: () => boolean): Promise<HeldChatRow[]> {
    const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
    const rows: HeldChatRow[] = [];
    const files = new Set<string>();
    for (const node of await getSavedNodes()) {
        const url = node.url;
        if (!isPlainNodeAddress(url) || (anchor && sameCommunity(url, anchor))) continue;
        if (await isGuestNode(url).catch(() => true)) continue;
        const file = getDatabaseFilenameForNode(url);
        if (files.has(file)) continue;
        files.add(file);
        // Chat left: no further community's copy is opened (one opened since the close as it was left closes as this ends).
        if (!inView()) break;
        const chats = await getHeldConversations(myPubkey, url);
        if (!chats) continue;
        const savedName = (node as { name?: unknown }).name;
        const name = typeof savedName === 'string' && savedName.trim() ? savedName.trim() : communityName(node);
        for (const chat of chats) rows.push({ ...chat, key: `held:${file}:${chat.id}`, held: true, community: url, communityName: name });
    }
    return rows;
}
