/**
 * group-photo-cache — a group chat's opened photos on this phone (DESIGN-group-chat-photos-fable.md §2.3, §2.4): kept by
 * message id as a DM's are (utils/db.ts getDecryptedAttachment), in the OS cache folder, one folder per group, so a group
 * this phone is no longer in is cleared in one go. Decrypted at rest is accepted, as for DM photos: the encryption keeps
 * the photo from the node, and the phone's owner already sees it.
 *
 * A name the node served becomes a file name here only when it is a plain id: nothing it serves can name a file outside
 * the group's folder, or a folder outside the photos'.
 */
import * as FileSystem from 'expo-file-system/legacy';
import type { GroupPhotoCache } from './group-chat-lines';

const GROUP_PHOTO_DIR = `${FileSystem.cacheDirectory}chat-images/groups/`;
const PLAIN_ID = /^[0-9a-z][0-9a-z-]{0,63}$/;
const JPEG_DATA_URI = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is;

const folderOf = (groupId: string): string | null => (PLAIN_ID.test(groupId) ? `${GROUP_PHOTO_DIR}${groupId}/` : null);
const fileOf = (groupId: string, messageId: string): string | null => {
    const folder = folderOf(groupId);
    return folder && PLAIN_ID.test(messageId) ? `${folder}${messageId}.jpg` : null;
};

/** Where GroupChatView keeps the photos it opened (utils/group-chat-lines.ts getDecryptedGroupAttachment). */
export const groupPhotoCache: GroupPhotoCache = {
    async get(groupId, messageId) {
        const file = fileOf(groupId, messageId);
        return file && (await FileSystem.getInfoAsync(file)).exists ? file : null;
    },
    async put(groupId, messageId, dataUri) {
        const file = fileOf(groupId, messageId);
        const jpeg = dataUri.match(JPEG_DATA_URI);
        // Drawn from memory this once when it can't be kept under a plain name, as a DM photo of an unknown shape is.
        if (!file || !jpeg) return dataUri;
        try { await FileSystem.makeDirectoryAsync(folderOf(groupId)!, { intermediates: true }); } catch {}
        try {
            await FileSystem.writeAsStringAsync(file, jpeg[1], { encoding: 'base64' });
        } catch {
            // Not kept (a full disk): the photo opened, so it draws from memory this once. Android writes the file in place,
            // so part of it may sit under its name: taken off, or the next view would read a cut-off file as kept.
            await FileSystem.deleteAsync(file, { idempotent: true }).catch(() => { /* the OS trims its cache folder anyway */ });
            return dataUri;
        }
        return file;
    },
};

/**
 * Take a group's opened photos off this phone, best effort and with no promise in words: the node no longer serves this
 * phone the group's chat (a removed member, a leaver), as it no longer serves the words (§2.4).
 */
export async function forgetGroupPhotos(groupId: string): Promise<void> {
    const folder = folderOf(groupId.toLowerCase());
    if (!folder) return;
    try { await FileSystem.deleteAsync(folder, { idempotent: true }); } catch { /* the OS trims its cache folder anyway */ }
}

/**
 * The kept files this session already took off for a removed line: each is asked once, not on every poll. One the OS
 * failed to take off leaves the set, so the next read asks again: the photo never stays for the session's want of a retry.
 */
const removedPhotos = new Set<string>();

/**
 * A line the node now serves as removed (deleted by its author, removed by a convenor) takes its kept photo with it, on
 * every phone that opened it. Not waited on: the chat's read doesn't wait for the cache folder.
 */
export function forgetRemovedGroupPhotos(groupId: string, messages: unknown): void {
    if (!Array.isArray(messages)) return;
    for (const m of messages) {
        if (m?.type !== 'removed') continue;
        const file = fileOf(groupId.toLowerCase(), String(m.id));
        if (!file || removedPhotos.has(file)) continue;
        if (removedPhotos.size >= 5000) removedPhotos.clear();
        removedPhotos.add(file);
        FileSystem.deleteAsync(file, { idempotent: true }).catch(() => { removedPhotos.delete(file); });
    }
}
