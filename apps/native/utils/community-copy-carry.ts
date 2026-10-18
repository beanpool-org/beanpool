/**
 * A community's copy goes with it to its new address (utils/address-follow.ts: the member chose "Use the new address",
 * and the new address was checked to be the same community).
 *
 * The phone keeps one SQLite file per address (utils/nodes.ts getDatabaseFilenameForNode), and per file what guards the
 * member's chats against the node itself: each DM's pinned key and what the member's reset set aside, the DM guard list
 * and its set-aside, the lines the update held (storage-keys.ts PER_FILE_STORE_KEYS, per account), the group chats' keys
 * with their highest epoch and sticky lock (in the file itself: utils/group-chat-store.ts), and the sync cursors with the
 * server's take-over count (`pillar_sync_<file>_*`). A switch to the new address alone opens an empty file there: the pins
 * seeded again from whatever the node lists then (#1863 T5), every group chat back at epoch 0, and the whole community
 * synced again over mobile data (review of #2138). So they move with it, as utils/cache-file-migration.ts moves a copy to
 * a new name:
 *   1. A copy already under the new address's name (the phone had been there): nothing is carried over it. Both stay, the
 *      phone uses the one it has there, and the old one stays under the old name ('kept-both', said in the log).
 *   2. The per-account keys are copied first, the new name's made exactly the old name's (one the old name has none of is
 *      removed under the new name: with no file there, it describes no copy). The old name's stay where they are: a pin
 *      is only ever removed by the member's reset (utils/dm-peer-pins.ts).
 *   3. The cursors leave the old name, the file is folded (a checkpoint) and renamed, and the cursors are written under the
 *      new name. A file without its cursors costs one whole sync; cursors without their file would make the next sync skip
 *      everything older than them into an empty copy, so neither name ever has cursors without the file.
 *   4. The caller writes the new address only once this resolves (utils/reconnect.ts switchPhoneTo).
 * A crash anywhere leaves the phone at the old address with its pins and guard list where they were. Before the rename
 * nothing of the old name's has changed but its cursors (one whole sync). After it, the old address opens an empty file
 * with its pins still stored (so no seed runs there), and a second "Use the new address" finds the carried copy under the
 * new name (1) with its keys (2). The phone is never at the new address with them empty.
 *
 * Runs with no copy open and none opened meanwhile (utils/db.ts whileCopyMoves). Throws when a step up to the rename fails;
 * the phone then stays where it is.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { t } from '@beanpool/core';
import { databaseDirectory, exists, fileUri, renameCopyFile } from './cache-file-migration';
import { getDatabaseFilenameForNode } from './nodes';
import { PER_FILE_STORE_KEYS } from './storage-keys';

/** What a carry did: 'carried', or 'kept-both' (a copy was already under the new address's name: nothing carried over it). */
export type CopyCarry = 'carried' | 'kept-both';

/** One per-account key of a file: its key now, and the same key under another file's name. */
interface FileKey { key: string; under(file: string): string }

/** Every PER_FILE_STORE_KEYS key of `file` among `keys`, whichever account it is for. */
function perAccountKeysOf(keys: readonly string[], file: string): FileKey[] {
    const found: FileKey[] = [];
    for (const keyOf of PER_FILE_STORE_KEYS) {
        // The key's shape around the account: `<head><account><tail>`. No account or file name has a ':' in it.
        const [head, tail] = keyOf('\u0001', file).split('\u0001');
        for (const key of keys) {
            if (!key.startsWith(head) || !key.endsWith(tail) || key.length <= head.length + tail.length) continue;
            const account = key.slice(head.length, key.length - tail.length);
            if (!account.includes(':')) found.push({ key, under: (other) => keyOf(account, other) });
        }
    }
    return found;
}

/** The sync cursors of `file` among `keys` (services/pillar-sync.ts getSyncCursorKey), by what follows the file's name. */
function cursorIdsOf(keys: readonly string[], file: string): string[] {
    const prefix = `pillar_sync_${file}_`;
    return keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

const cursorKey = (file: string, id: string) => `pillar_sync_${file}_${id}`;

/** Carry the copy of the community at `from` to `to`'s name (the file's comment). Throws, the phone to stay where it is, when it can't. */
export async function carryCommunityCopy(from: string, to: string): Promise<CopyCarry> {
    const fromFile = getDatabaseFilenameForNode(from);
    const toFile = getDatabaseFilenameForNode(to);
    const directory = databaseDirectory();
    const cursors: [string, string][] = [];
    try {
        if (!directory) throw new Error('No folder for community copies on this phone');
        if (fromFile === toFile) return 'carried';
        if (await exists(fileUri(directory, toFile))) {
            console.warn(`[DB] Following ${from} to ${to}: this phone already has a copy for ${to} (${toFile}), so that copy is used there and ${fromFile} stays on the phone, carried over nothing`);
            return 'kept-both';
        }
        const keys = await AsyncStorage.getAllKeys();

        // 2. The per-account keys: the new name's become the old name's, the old name's stay.
        const written = new Set<string>();
        for (const k of perAccountKeysOf(keys, fromFile)) {
            const value = await AsyncStorage.getItem(k.key);
            if (value === null) continue;
            await AsyncStorage.setItem(k.under(toFile), value);
            written.add(k.under(toFile));
        }
        for (const k of perAccountKeysOf(keys, toFile)) {
            if (!written.has(k.key)) await AsyncStorage.removeItem(k.key);
        }

        // 3. The cursors leave the old name before the file does. Any under the new name describe no file there.
        for (const id of cursorIdsOf(keys, fromFile)) {
            const value = await AsyncStorage.getItem(cursorKey(fromFile, id));
            if (value !== null) cursors.push([id, value]);
        }
        await AsyncStorage.multiRemove([
            ...cursorIdsOf(keys, toFile).map((id) => cursorKey(toFile, id)),
            ...cursorIdsOf(keys, fromFile).map((id) => cursorKey(fromFile, id)),
        ]);
        if (!(await exists(fileUri(directory, fromFile)))) {
            // No copy under the old name (none written yet): the keys alone go, and cursors with no file go nowhere.
            return 'carried';
        }
        await renameCopyFile(directory, fromFile, toFile);
    } catch (e) {
        console.warn(`[DB] Could not carry the copy of ${from} to ${to}; the phone stays at ${from}`, e);
        // The rename didn't happen: the cursors go back to the file they describe (else it costs one whole sync).
        if (cursors.length && directory && (await exists(fileUri(directory, fromFile)).catch(() => false))) {
            for (const [id, value] of cursors) await AsyncStorage.setItem(cursorKey(fromFile, id), value).catch(() => {});
        }
        throw new Error(t('Nothing has changed. Try again in a little while.'));
    }
    // After the rename the carry stands: a cursor that can't be written costs one whole sync, never the move.
    for (const [id, value] of cursors) {
        await AsyncStorage.setItem(cursorKey(toFile, id), value).catch((e) => console.warn(`[DB] A sync cursor of ${to} could not be kept; its next sync reads it whole`, e));
    }
    return 'carried';
}
