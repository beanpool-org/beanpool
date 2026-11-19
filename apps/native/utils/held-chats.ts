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
import { getHeldConversations, type HeldConversation } from './db';
import { getDatabaseFilenameForNode, getSavedNodes, isGuestNode } from './nodes';
import { isPlainNodeAddress } from './node-url';
import { sameCommunity } from './push-pins';
import { communityName } from './community-name';

export interface HeldChatRow extends HeldConversation {
    /** The row's key in Chat's list: never that of a chat in the community in use, nor of the same id in another. */
    key: string;
    held: true;
    /** The community's address, as the saved list has it: where a tap moves the phone. */
    community: string;
    /** Its name as the phone saved it, in grey under the person's. */
    communityName: string;
}

export async function heldChatRows(myPubkey: string): Promise<HeldChatRow[]> {
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
        const chats = await getHeldConversations(myPubkey, url);
        if (!chats) continue;
        const savedName = (node as { name?: unknown }).name;
        const name = typeof savedName === 'string' && savedName.trim() ? savedName.trim() : communityName(node);
        for (const chat of chats) rows.push({ ...chat, key: `held:${file}:${chat.id}`, held: true, community: url, communityName: name });
    }
    return rows;
}
