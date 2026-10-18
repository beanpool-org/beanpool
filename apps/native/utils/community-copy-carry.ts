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
 * synced again over mobile data (review of #2138). So they go with it, in this order:
 *   1. Each per-account key the old name holds goes to the new name add-only ({@link MERGES}): nothing the new name holds
 *      is replaced or removed, and an account the old name holds nothing for is not touched (an account's pins stay on the
 *      phone when it leaves: storage-keys.ts). A DM both names pin to different keys keeps the new name's pin, and the old
 *      key is offered there: the member decides, as when a node lists another key. The old name's keys stay where they
 *      are: a pin is only ever removed by the member's reset (utils/dm-peer-pins.ts).
 *   2. A copy already under the new name (the phone had been there): its rows stay, and the old copy's group chat keys
 *      are added to it the same way (group-chat-store.ts addGroupKeyState: the higher highest epoch, the sticky lock when
 *      either held it). The old copy stays under the old name with its cursors ('kept-both', said in the log).
 *      Otherwise the new name's cursors go (they describe no copy there), the old copy is copied under the new name
 *      (cache-file-migration.ts copyCopyFile: folded, written beside it and renamed into place), and its cursors are
 *      written under the new name after it.
 *   3. The address is written (`writeAddress`: utils/reconnect.ts switchPhoneTo).
 *   4. Only then, unless a copy was already under the new name, the old name's cursors go, and then its file.
 * So a stop at any write leaves the phone at the old address with everything there, or at the new address with everything
 * there: never at either with an empty copy and its group chats' highest epoch gone (confirmation 2 of #2138). A copy a
 * stop leaves under the new name before the address is written is the phone's own, whole, with its cursors or with none
 * (one whole sync), and the next tap takes it as in 2.
 *
 * A step up to 3 that fails throws "Nothing has changed", which is so: the phone stays where it is with everything, and a
 * copy this run put under the new name is taken off again. One in 4 is logged: the move stands, and what is left of the
 * old copy is what a stop there leaves (its file, with its cursors or with none).
 *
 * Runs with no copy open and none opened meanwhile (utils/db.ts whileCopyMoves).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import { t } from '@beanpool/core';
import { copyCopyFile, databaseDirectory, deleteCopyFile, exists, fileUri } from './cache-file-migration';
import { getDatabaseFilenameForNode } from './nodes';
import {
    PER_FILE_STORE_KEYS, dmConversationsSeenSetAsideStoreKey, dmConversationsSeenStoreKey, dmLinesAtUpdateStoreKey,
    dmPeerPinsSetAsideStoreKey, dmPeerPinsStoreKey,
} from './storage-keys';
import { pinsWithCarried } from './dm-peer-pins';
import { seenWithCarried } from './dm-guard-list';
import { addGroupKeyState, type SqliteLike } from './group-chat-store';
import { linesHeldWithCarried } from './db';

/** What a carry did: 'carried', or 'kept-both' (a copy was already under the new address's name: its rows stay). */
export type CopyCarry = 'carried' | 'kept-both';

type KeyOf = (publicKey: string, file: string) => string;

/**
 * How one per-account key takes the old name's value under the new name: `here`, the new name's value now (null: none);
 * `carried`, the old name's. Answers the value to write, or null for nothing.
 */
type Merge = (here: string | null, carried: string, at: { copyHere: boolean; now: string }) => string | null;

/** A set-aside, kept for the record and never read: the new name's own stays, and the old name's goes only where there is none. */
const keepHere: Merge = (here, carried) => (here == null ? carried : null);

/** How each PER_FILE_STORE_KEYS key goes, add-only (community-copy-carry.test.ts checks none is missing). */
export const MERGES: ReadonlyMap<KeyOf, Merge> = new Map<KeyOf, Merge>([
    [dmPeerPinsStoreKey, (here, carried, { now }) => pinsWithCarried(here, carried, now)],
    [dmPeerPinsSetAsideStoreKey, keepHere],
    [dmConversationsSeenStoreKey, (here, carried, { copyHere, now }) => seenWithCarried(here, carried, copyHere, now)],
    [dmConversationsSeenSetAsideStoreKey, keepHere],
    [dmLinesAtUpdateStoreKey, (here, carried) => linesHeldWithCarried(here, carried)],
]);

/** One per-account key of a file: its key now, how it goes, and the same key under another file's name. */
interface FileKey { key: string; merge: Merge; under(file: string): string }

/** Every PER_FILE_STORE_KEYS key of `file` among `keys`, whichever account it is for. */
function perAccountKeysOf(keys: readonly string[], file: string): FileKey[] {
    const found: FileKey[] = [];
    for (const keyOf of PER_FILE_STORE_KEYS) {
        // The key's shape around the account: `<head><account><tail>`. No account or file name has a ':' in it.
        const [head, tail] = keyOf('\u0001', file).split('\u0001');
        const merge = MERGES.get(keyOf) ?? keepHere;
        for (const key of keys) {
            if (!key.startsWith(head) || !key.endsWith(tail) || key.length <= head.length + tail.length) continue;
            const account = key.slice(head.length, key.length - tail.length);
            if (!account.includes(':')) found.push({ key, merge, under: (other) => keyOf(account, other) });
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

/** 1: each per-account key the old name holds, into the new name's add-only. Throws when a read or write fails. */
async function carryKeys(keys: readonly string[], fromFile: string, toFile: string, copyHere: boolean): Promise<void> {
    const now = new Date().toISOString();
    for (const k of perAccountKeysOf(keys, fromFile)) {
        const carried = await AsyncStorage.getItem(k.key);
        if (carried === null) continue;
        const target = k.under(toFile);
        const value = k.merge(await AsyncStorage.getItem(target), carried, { copyHere, now });
        if (value !== null) await AsyncStorage.setItem(target, value);
    }
}

/** 2, with a copy under the new name: the old copy's group chat keys added to it. */
async function addGroupKeysOfCopy(fromFile: string, toFile: string): Promise<void> {
    const old = await SQLite.openDatabaseAsync(fromFile, { useNewConnection: true });
    try {
        const into = await SQLite.openDatabaseAsync(toFile, { useNewConnection: true });
        try {
            // expo-sqlite's handles, as db.ts hands its own to the store (groupKeyStore).
            await addGroupKeyState(old as unknown as SqliteLike, into as unknown as SqliteLike & { execAsync(source: string): Promise<void> });
        } finally {
            await into.closeAsync();
        }
    } finally {
        await old.closeAsync();
    }
}

/**
 * Carry the copy of the community at `from` to `to`'s name and write the address with `writeAddress` (the file's
 * comment). Throws "Nothing has changed", the phone to stay where it is, when a step up to the address fails.
 */
export async function carryCommunityCopy(from: string, to: string, writeAddress: () => Promise<void>): Promise<CopyCarry> {
    const fromFile = getDatabaseFilenameForNode(from);
    const toFile = getDatabaseFilenameForNode(to);
    const directory = databaseDirectory();
    let result: CopyCarry = 'carried';
    let copied = false;
    const landedCursors: string[] = [];
    try {
        if (!directory) throw new Error('No folder for community copies on this phone');
        if (fromFile !== toFile) {
            const copyHere = await exists(fileUri(directory, toFile));
            const copyThere = await exists(fileUri(directory, fromFile));
            const keys = await AsyncStorage.getAllKeys();
            await carryKeys(keys, fromFile, toFile, copyHere);
            if (copyHere) {
                if (copyThere) await addGroupKeysOfCopy(fromFile, toFile);
                console.warn(copyThere
                    ? `[DB] Following ${from} to ${to}: this phone already has a copy for ${to} (${toFile}), so that copy is used there, with what guards the chats added to it; ${fromFile} stays on the phone`
                    : `[DB] Following ${from} to ${to}: this phone already has a copy for ${to} (${toFile}), so that copy is used there, with what guards the chats added to it; no copy of ${from} is left on the phone`);
                result = 'kept-both';
            } else {
                // Cursors under the new name describe no copy there: never left for the copy to land beside.
                await AsyncStorage.multiRemove(cursorIdsOf(keys, toFile).map((id) => cursorKey(toFile, id)));
                if (copyThere) {
                    await copyCopyFile(directory, fromFile, toFile);
                    copied = true;
                    for (const id of cursorIdsOf(keys, fromFile)) {
                        const value = await AsyncStorage.getItem(cursorKey(fromFile, id));
                        if (value === null) continue;
                        landedCursors.push(cursorKey(toFile, id));
                        await AsyncStorage.setItem(cursorKey(toFile, id), value);
                    }
                }
            }
        }
        await writeAddress();
    } catch (e) {
        console.warn(`[DB] Could not carry the copy of ${from} to ${to}; the phone stays at ${from} with its copy`, e);
        if (copied && directory) {
            // The copy this run put under the new name goes again, its cursors first: the next tap copies it afresh.
            try {
                await AsyncStorage.multiRemove(landedCursors);
                await deleteCopyFile(directory, toFile);
            } catch (left) {
                console.warn(`[DB] The copy put under ${to}'s name stays there; the next tap uses it`, left);
            }
        }
        throw new Error(t('Nothing has changed. Try again in a little while.'));
    }
    if (result === 'carried' && fromFile !== toFile) {
        // 4. The old copy goes, its cursors first: a file without its cursors costs one whole sync if the phone comes back
        // to that address; cursors without their file would skip everything older into an empty copy there.
        try {
            await AsyncStorage.multiRemove(cursorIdsOf(await AsyncStorage.getAllKeys(), fromFile).map((id) => cursorKey(fromFile, id)));
            if (copied) await deleteCopyFile(directory, fromFile);
        } catch (e) {
            console.warn(`[DB] The old copy of ${from} (${fromFile}) stays on the phone; the phone is at ${to} with its copy`, e);
        }
    }
    return result;
}
